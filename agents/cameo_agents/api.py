"""Cameo API (FastAPI): the whole pipeline behind the web app. Run: scripts/run_api.sh (uvicorn, port 8787).

Google AI per step:
  Gemini 3.8 Flash (Vertex AI)  scene understanding, placement boxes, product match per audience, drawn-box identify,
                                edit prompts, clip verification
  Cloud Vision                  object localization on keyframes; snaps drawn boxes to the object under them
  Nano Banana                   preview stills (the keyframe edited with each audience's products)
  Gemini Omni                   the shot's video edited to match the approved still

Episodes
  POST   /uploads                        {name, size, type} -> a signed Cloud Storage PUT for a large video
  POST   /episodes                       multipart `file`, or {upload: key} (+ trim) -> {jobId, episodeId}; ingest, then confirm
  POST   /episodes/{id}/rerun            re-cut shots from the source and re-run detection (confirm again)
  GET    /episodes/{id}                  {episodeId, sample, hasDetected, duration, shots}
  DELETE /episodes/{id}                  the episode and everything made from it
  GET    /episodes/{id}/detected.json    boxes, scenes and suggestions for the web app (?match=<id> for a re-match)
  GET    /episodes/{id}/media/proxy      360p proxy (Range); /media/keyframes/{name}
Jobs (server-sent events)
  GET    /jobs/{id}/events               stage events: ingest, vision, understand, localise, match, job
  POST   /jobs/{id}/confirm              {catalog, audiences}: run detection or a re-match; /cancel; GET /jobs/{id}
Placement
  POST   /episodes/{id}/match            re-match products for a new catalog or audience list (cost-gated job)
  POST   /episodes/{id}/identify         a drawn box: Vision snap + Gemini names it and picks products
  POST   /episodes/{id}/prompt           Gemini writes the edit prompt for a product placed in a box
  GET    /episodes/{id}/tracks           Gemini's boxes followed through each shot; POST /track for a drawn box
Generation
  POST   /episodes/{id}/previews         Nano Banana still for one scene version; GET /previews/{id}.png
  POST   /episodes/{id}/renders          Gemini Omni clip + Gemini check; GET /renders/{id}[.mp4|.jpg], /clips/{shot}.mp4
  POST   /episodes/{id}/masters          the episode for one audience with its rendered shots cut in
Samples, analytics, config
  GET    /samples, /episodes/{id}/sample  ready-made episodes (scripts/make_sample.py)
  POST   /events, GET /episodes/{id}/analytics   viewer events (events.py)
  GET    /config                          upload limit, models and prices shown before anything is spent

Every model result is cached on disk under out/<episode>/ by a hash of its inputs, so a repeated request costs nothing.
Paid requests are guarded by limits.py: dollar ceilings per day for one browser, one network and the whole server
(HTTP 429 past them, with an emailed alert); uploads stop when stored uploads pass CAMEO_MAX_STORE_MB, and at most CAMEO_MAX_RENDERS Omni renders run at once.
Env: CAMEO_API_LLM (default "gemini"), CAMEO_VISION ("cloud"), CAMEO_CORS_ORIGINS, CAMEO_MAX_SECONDS, CAMEO_MAX_UPLOAD_MB,
CAMEO_DAILY_BUDGET_USD, CAMEO_VISITOR_CAP_USD, CAMEO_NETWORK_CAP_USD, CAMEO_MAX_STORE_MB, CAMEO_MAX_RENDERS.
"""

from __future__ import annotations

import anyio.to_thread
import json
import os
import re
import shutil
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Iterator

from starlette.concurrency import run_in_threadpool
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import events as events_api
from . import limits as limits_mod
from . import ops
from . import storage_sync
from . import vision as vision_mod
from .catalog import CatalogError, audience_lines, catalog_hash, parse_audiences, parse_catalog, to_products
from .detected import build_detected
from .ingest import MIN_GAP, ingest, load_ingest, probe, trim_video  # noqa: F401
from .models import BUSY_MESSAGE, PRICE_PER_M, busy, get_llm
from .pipeline import MIN_SHOT_S, load_catalog, run, stage1, stage2, stage3_single
from .schemas import Box, RuleSet, SceneRerank, SceneUnderstanding, is_skipped

ROOT = Path(__file__).resolve().parent.parent


def load_env(path: Path = ROOT / ".env") -> None:
    """Vertex settings (GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_CLOUD_PROJECT, ...) from agents/.env; the shell's own env wins."""
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip().removeprefix("export ").strip(), v.strip().strip('"').strip("'"))


load_env()
OUT_ROOT = ROOT / "out"
# With CAMEO_BUCKET set, runtime data is copied to Cloud Storage and restored, so the server can sleep and redeploy.
STORE = storage_sync.from_env(OUT_ROOT)
STORE.restore_state()
STORE.baseline()
# Uploads longer than MAX_SECONDS are refused unless the client asks to keep the first MAX_SECONDS (Gemini Omni edits
# at most 10 s per call, and the cap keeps hosted spend small). MAX_UPLOAD_MB bounds the file itself.
MAX_UPLOAD_MB = int(os.environ.get("CAMEO_MAX_UPLOAD_MB", "100"))
MAX_SECONDS = float(os.environ.get("CAMEO_MAX_SECONDS", "10"))
PING_EVERY = 10.0
COST_PER_CALL = 0.007  # USD, average Gemini 3.8 Flash detection call, for the estimate shown before detection runs
ID_RE = re.compile(r"^[a-z0-9-]+$")
NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+\.jpg$")
TERMINAL = ("complete", "failed", "cancelled")

@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Sync handlers, every open job stream and the long preview/render calls share one thread pool: room for all.
    anyio.to_thread.current_default_thread_limiter().total_tokens = 200
    STORE.start()
    yield
    STORE.stop()


# No interactive docs or schema in production: docs/api.md describes the API.
app = FastAPI(title="Cameo API", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
def cors_origins(value: str | None) -> list[str]:
    return [o.strip().rstrip("/") for o in (value or "").split(",") if o.strip()]


CORS_ORIGINS = cors_origins(os.environ.get("CAMEO_CORS_ORIGINS"))
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
)
LIMITS = limits_mod.from_env(OUT_ROOT, ops.alert)
MAX_STORE_MB = int(os.environ.get("CAMEO_MAX_STORE_MB", "1500"))  # uploads live in instance memory on Cloud Run
MAX_RENDERS = int(os.environ.get("CAMEO_MAX_RENDERS", "3"))  # Gemini Omni renders running at once
events_api.configure(lambda: OUT_ROOT, lambda eid: STORE.ensure(eid))
ops.configure(lambda: OUT_ROOT, lambda: LIMITS)
app.include_router(ops.router)
app.include_router(events_api.router)


# ---------------------------------------------------------------- jobs


class Cancelled(Exception):
    pass


class Job:
    def __init__(self, episode_id: str, video: Path | None = None, rerun: bool = False, kind: str = "detect"):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind  # detect | match
        self.catalog: list | None = None  # CatalogProduct[] from the confirm / match body
        self.audiences: list | None = None
        self.episode_id = episode_id
        self.video = video
        self.rerun = rerun
        self.trim_to: float | None = None  # seconds: keep only the start of an upload
        self.estimate = 0.0  # USD, shown at needs_confirmation and reserved against the budget on confirm
        self.who: dict = {"visitor": "server"}  # who confirmed it (ops.who)
        self.out = OUT_ROOT / episode_id
        self.state = "queued"  # queued | running | awaiting_confirmation | complete | failed | cancelled
        self.events: list[dict] = []
        self.cond = threading.Condition()
        self.cancel_flag = threading.Event()
        self.counts: dict[str, Any] = {}
        self.totals = {"tokens": 0, "cost": 0.0, "calls": 0, "seconds": 0.0}
        self.current = "ingest"

    def emit(self, stage: str, state: str, message: str = "", **kw: Any) -> None:
        with self.cond:
            if self.state in TERMINAL:
                return
            ev = {"seq": len(self.events), "t": round(time.time(), 3), "stage": stage, "state": state, "message": message}
            ev.update({k: v for k, v in kw.items() if v is not None})
            self.events.append(ev)
            if stage == "job" and state in TERMINAL:
                self.state = state
            self.cond.notify_all()

    def check(self) -> None:
        if self.cancel_flag.is_set():
            raise Cancelled()

    def summary(self) -> dict:
        return {"jobId": self.id, "episodeId": self.episode_id, "kind": self.kind, "state": self.state, "rerun": self.rerun, "events": len(self.events), "counts": self.counts}


JOBS: dict[str, Job] = {}


def get_job(job_id: str) -> Job:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "unknown job")
    return job


# ---------------------------------------------------------------- counts and usage


def cost_of(entries: list[dict]) -> float:
    tot = {k: sum(e.get(k, 0) for e in entries) for k in ("prompt", "output", "thoughts", "cached")}
    fresh = tot["prompt"] - tot["cached"]
    return round((fresh * PRICE_PER_M["input"] + tot["cached"] * PRICE_PER_M["cached"] + (tot["output"] + tot["thoughts"]) * PRICE_PER_M["output"]) / 1e6, 5)


def usage_of(entries: list[dict]) -> dict:
    return {"tokens": sum(e.get("total", 0) for e in entries), "cost": cost_of(entries), "calls": len(entries)}


def count_ingest(ing) -> dict:
    return {"shots": len(ing.shots), "keyframes": sum(len(s.keyframes) for s in ing.shots)}


def count_understand(scenes: list[SceneUnderstanding]) -> dict:
    return {"scenes": len(scenes), "surfaces": sum(len(s.surfaces) for s in scenes), "skipped": sum(1 for s in scenes if is_skipped(s))}


def count_localise(s2: dict, scenes: list[SceneUnderstanding]) -> dict:
    """areas = non-face boxes (what detected.json lists as `boxes`); skipped = scenes the skip rule blocks."""
    return {"areas": sum(1 for b in s2["boxes"] if b.get("kind") != "face"), "skipped": sum(1 for s in scenes if is_skipped(s))}


def count_match(s3: dict) -> dict:
    """suggestions = total product picks (box x region x product); lists = (box, region) lists; matchedBoxes = boxes with any pick."""
    reranks = [SceneRerank.model_validate(r) for r in s3["reranks"]]
    sugs = [s for rr in reranks for s in rr.suggestions if s.suggestions]
    return {"suggestions": sum(len(s.suggestions) for s in sugs), "lists": len(sugs), "matchedBoxes": len({s.boxId for s in sugs})}


def fail(job: Job, e: Exception) -> None:
    ops.record(f"{job.kind}_failed", **job.who, episode=job.episode_id, stage=job.current, error=str(e)[:200])
    msg = BUSY_MESSAGE if busy(e) else f"{type(e).__name__}: {e}"
    job.emit(job.current, "failed", msg)
    job.emit("job", "failed", msg)


# ---------------------------------------------------------------- upload path


def estimate(ing, out: Path | None = None) -> tuple[int, float]:
    """Gemini calls = 1 (stage 1) + 3 keyframes per shot of >= MIN_SHOT_S (stage 2 upper bound) + 1 (stage 3), plus one
    Cloud Vision request per keyframe not cached yet ($1.50 / 1,000)."""
    stage2_calls = sum(len(s.keyframes) for s in ing.shots if s.duration >= MIN_SHOT_S)
    calls = 1 + stage2_calls + 1
    v_calls, v_cost = vision_mod.estimate(ing, out) if out is not None else (sum(len(s.keyframes) for s in ing.shots), sum(len(s.keyframes) for s in ing.shots) * vision_mod.PRICE_PER_IMAGE)
    return calls + v_calls, round(calls * COST_PER_CALL + v_cost, 2)


def run_ingest(job: Job) -> None:
    try:
        job.state = "running"
        job.current = "ingest"
        t0 = time.monotonic()

        def on_progress(msg: str, frac: float) -> None:
            job.check()
            job.emit("ingest", "progress", msg, progress=round(frac, 2))

        # A trimmed .mov/.webm upload became source.mp4; a stored copy of the untrimmed original can come back with a
        # restore, so the .mp4 wins.
        source = min(job.out.glob("source.*"), key=lambda p: p.suffix != ".mp4", default=None)
        if job.rerun and source is not None:
            # Re-cutting the shots invalidates everything keyed by them.
            job.emit("job", "running", "Re-extracting: cutting shots again from the source")
            job.emit("ingest", "running", "Cutting shots, proxy and keyframes", progress=0.0)
            subs = ("keyframes", "frames", "cache/vision", "masks", "match", "identify", "previews", "clips", "renders", "masters", "tracks")
            for sub in subs:
                shutil.rmtree(job.out / sub, ignore_errors=True)
            STORE.drop(job.episode_id, subs)
            ing = ingest(source, job.out, on_progress=on_progress, episode_id=job.episode_id)
        elif job.rerun:
            job.emit("job", "running", "Re-running detection on existing ingest")
            job.emit("ingest", "running", "Using existing shots and keyframes", progress=0.0)
            ing = load_ingest(job.out)
        else:
            job.emit("job", "running", "Processing upload")
            job.emit("ingest", "running", "Cutting shots, proxy and keyframes", progress=0.0)

            if job.trim_to:
                job.emit("ingest", "progress", f"Keeping the first {job.trim_to:g} s", progress=0.02)
                job.video = trim_video(job.video, job.trim_to)
            ing = ingest(job.video, job.out, on_progress=on_progress, episode_id=job.episode_id)
        job.check()
        counts = count_ingest(ing)
        job.counts.update(counts)
        job.emit("ingest", "done", f"{counts['shots']} shots · {counts['keyframes']} keyframes", counts=counts, seconds=round(time.monotonic() - t0, 1), progress=1.0)
        calls, cost = estimate(ing, job.out)
        job.estimate = cost
        with job.cond:
            if job.state in TERMINAL:
                return
            job.state = "awaiting_confirmation"
        job.emit("understand", "needs_confirmation", f"Run detection on Vertex AI and Cloud Vision · ~${cost:.2f} · {calls} calls", calls=calls, cost=cost)
    except Cancelled:
        pass
    except (Exception, SystemExit) as e:  # noqa: BLE001 (SystemExit: missing Vertex config raises it)
        fail(job, e)


def clear_stage_caches(out: Path, llm_name: str) -> list[str]:
    """Delete the stage 1-3 cache files for one LLM (stage1.json, stage2*, stage3*); ingest, media and other LLMs' caches stay."""
    d = out / "cache" / llm_name
    gone = []
    for pat in ("stage1.json", "stage2*", "stage3*"):
        for f in d.glob(pat):
            if f.is_file():
                f.unlink()
                gone.append(f.name)
    return gone


def run_detection(job: Job) -> None:
    """Stages 1-3 with the real pipeline functions (each cached to disk), then run() writes scenes.json / web.json from the cache."""
    try:
        llm = get_llm(os.environ.get("CAMEO_API_LLM", "gemini"))
        if job.rerun:
            clear_stage_caches(job.out, llm.name)
        ing = load_ingest(job.out)
        products, rules, regions = job_catalog(job, llm)
        used = [0]
        totals = {"tokens": 0, "cost": 0.0, "calls": 0}
        run_t0 = time.monotonic()

        def step(stage: str, label: str, fn, count):
            job.current = stage
            job.check()
            job.emit(stage, "running", label, progress=0.0)
            t0 = time.monotonic()
            result = fn()
            job.check()
            new = list(getattr(llm, "usage", []))[used[0]:]
            used[0] += len(new)
            u = usage_of(new) if new else {}
            counts = count(result)
            job.counts.update(counts)
            for k in totals:
                totals[k] += u.get(k, 0)
            return result, counts, u, round(time.monotonic() - t0, 1)

        job.emit("job", "running", f"Running detection ({llm.name})")
        job.current = "vision"
        # Cloud Vision runs on every keyframe while Gemini reads the whole video (stage 1); stage 2 needs both.
        job.emit("vision", "running", "Finding objects with Cloud Vision", progress=0.0)
        t0 = time.monotonic()
        vis_box: dict = {}

        def vision_task() -> None:
            try:
                vis_box["r"] = vision_mod.run_vision(ing, job.out, vision_mod.get_vision(), on_progress=lambda m, f: job.emit("vision", "progress", m, progress=round(f, 2)))
                vis_box["s"] = round(time.monotonic() - t0, 1)
            except BaseException as e:  # noqa: BLE001
                vis_box["e"] = e

        vt = threading.Thread(target=vision_task, daemon=True)
        vt.start()
        scenes, c1, u1, sec1 = step("understand", "Understanding scenes on Vertex AI", lambda: stage1(ing, job.out, llm), count_understand)
        vt.join()
        job.check()
        if "e" in vis_box:
            raise vis_box["e"]
        vis = vis_box["r"]
        c = {"visionFrames": vis["visionFrames"], "objects": vis["objects"]}
        job.counts.update(c)
        totals["cost"] += vis["cost"]
        job.emit("vision", "done", f"{c['objects']} objects in {c['visionFrames']} keyframes", counts=c, seconds=vis_box["s"], progress=1.0, calls=vis["calls"], cost=vis["cost"])
        job.emit("understand", "done", f"{c1['scenes']} scenes · {c1['surfaces']} surfaces · {c1['skipped']} skipped", counts=c1, seconds=sec1, progress=1.0, **u1)
        s2, c, u, sec = step("localise", "Finding placement areas", lambda: stage2(ing, job.out, llm, scenes), lambda r: count_localise(r, scenes))
        job.emit("localise", "done", f"{c['areas']} placement areas · {c['skipped']} skipped", counts=c, seconds=sec, progress=1.0, **u)
        skipped_ids = {s.shotId for s in scenes if is_skipped(s)}
        boxes = [b.model_copy(update={"blocked": True}) if b.shotId in skipped_ids and not b.blocked else b for b in (Box.model_validate(x) for x in s2["boxes"])]
        s3, c, u, sec = step("match", "Matching products", lambda: stage3_single(job.out, llm, scenes, boxes, products, rules, regions), count_match)
        job.emit("match", "done", f"{c['suggestions']} suggestions across {c['matchedBoxes']} areas", counts=c, seconds=sec, progress=1.0, **u)
        run(job.out, llm, stages=(1, 2, 3), products=products, rules=rules, regions=regions)  # all cached; writes scenes.json, web.json, usage
        clear_active_match(job.out)
        _warm_tracks(job.out)
        job.emit("job", "complete", "Detection complete", episodeId=job.episode_id, counts=job.counts, seconds=round(time.monotonic() - run_t0, 1),
                 tokens=totals["tokens"], cost=round(totals["cost"], 5), calls=totals["calls"])
        ops.record("detect_done", **job.who, episode=job.episode_id, cost=totals["cost"], calls=totals["calls"], areas=job.counts.get("areas"))
    except Cancelled:
        pass
    except (Exception, SystemExit) as e:  # noqa: BLE001 (SystemExit: missing Vertex config raises it)
        fail(job, e)


def job_catalog(job: Job, llm) -> tuple[list, RuleSet, list[str]]:
    """The confirm body's catalog expanded per audience; the bundled starter catalog (brands.json) when none is sent."""
    if job.catalog is not None:
        aud = job.audiences or []
        llm.audience_text = audience_lines(aud)  # the prompt names each audience (else it sees only their ids)
        return to_products(job.catalog, aud), RuleSet(), [a.id for a in aud]
    products, rules = load_catalog()
    return products, rules, list(dict.fromkeys(p.region for p in products))


def clear_active_match(out: Path) -> None:
    p = out / "match" / "active"
    if p.is_file():
        p.unlink()


def has_stage12(out: Path, llm_name: str) -> bool:
    d = out / "cache" / llm_name
    return (d / "stage1.json").is_file() and (d / "stage2.json").is_file()


def prepare_match(job: Job) -> None:
    calls, cost = 1, round(COST_PER_CALL, 2)
    job.estimate = COST_PER_CALL
    with job.cond:
        if job.state in TERMINAL:
            return
        job.state = "awaiting_confirmation"
    job.emit("job", "running", f"Re-matching products for {len(job.audiences or [])} audiences")
    job.emit("match", "needs_confirmation", f"Re-match products on Vertex AI · ~${cost:.2f} · {calls} call", calls=calls, cost=cost)


def run_match(job: Job) -> None:
    """Stage 3 only, on the cached stage 1-2 output; writes match/<matchId>/{web,scenes}.json and makes it the active match."""
    try:
        llm = get_llm(os.environ.get("CAMEO_API_LLM", "gemini"))
        job.current = "match"
        products, rules, regions = job_catalog(job, llm)
        mid = catalog_hash(job.catalog, job.audiences)
        t0 = time.monotonic()
        job.emit("match", "running", "Matching products", progress=0.0)
        ing = load_ingest(job.out)
        scenes = stage1(ing, job.out, llm)
        s2 = stage2(ing, job.out, llm, scenes)
        skipped_ids = {s.shotId for s in scenes if is_skipped(s)}
        boxes = [b.model_copy(update={"blocked": True}) if b.shotId in skipped_ids and not b.blocked else b for b in (Box.model_validate(x) for x in s2["boxes"])]
        name = f"stage3-{mid}.json"
        s3 = stage3_single(job.out, llm, scenes, boxes, products, rules, regions, cache_name=name)
        job.check()
        u = usage_of(list(getattr(llm, "usage", [])))
        c = count_match(s3)
        job.counts.update(c)
        run(job.out, llm, stages=(1, 2, 3), products=products, rules=rules, regions=regions, stage3_cache=name, write_to=job.out / "match" / mid)
        (job.out / "match" / "active").write_text(mid)
        sec = round(time.monotonic() - t0, 1)
        job.emit("match", "done", f"{c['suggestions']} suggestions across {c['matchedBoxes']} areas", counts=c, seconds=sec, progress=1.0, **u)
        job.emit("job", "complete", "Re-match complete", episodeId=job.episode_id, matchId=mid, counts=c, seconds=sec,
                 tokens=u.get("tokens", 0), cost=u.get("cost", 0.0), calls=u.get("calls", 0))
        ops.record("match_done", **job.who, episode=job.episode_id, cost=u.get("cost", 0.0))
    except Cancelled:
        pass
    except (Exception, SystemExit) as e:  # noqa: BLE001
        fail(job, e)


def parse_catalog_body(body) -> tuple[list, list]:
    if not isinstance(body, dict):
        raise HTTPException(400, "send {catalog: CatalogProduct[], audiences: Audience[]}")
    try:
        return parse_catalog(body.get("catalog")), parse_audiences(body.get("audiences"))
    except CatalogError as e:
        raise HTTPException(400, str(e))


async def _json_body(request: Request, max_bytes: int = 2_000_000):
    raw = await request.body()
    if not raw.strip():
        return None
    if len(raw) > max_bytes:
        raise HTTPException(413, "body too large")
    try:
        return json.loads(raw)
    except ValueError:
        raise HTTPException(400, "body must be JSON")


# ---------------------------------------------------------------- endpoints


def _valid_id(s: str) -> str:
    if not ID_RE.match(s):
        raise HTTPException(400, "bad id")
    STORE.ensure(s)  # after a sleep or redeploy, the episode comes back from Cloud Storage on first use
    return s


async def _valid_id_async(s: str) -> str:
    """_valid_id for async handlers: a restore downloads from Cloud Storage, which must not hold up the event loop."""
    if not ID_RE.match(s):
        raise HTTPException(400, "bad id")
    await run_in_threadpool(STORE.ensure, s)
    return s


@app.get("/health")
def health() -> dict:
    return {"ok": True}


INCOMING_RE = re.compile(r"^incoming/[0-9a-f]{32}\.[a-z0-9]{1,5}$")
VIDEO_TYPES = ("video/", "application/octet-stream")


@app.post("/uploads")
async def upload_url(request: Request) -> dict:
    """Large videos go straight from the browser to Cloud Storage (Cloud Run takes request bodies up to 32 MB):
    body {name, size, type} -> {key, url, headers}: a signed PUT for 15 minutes, no larger than MAX_UPLOAD_MB.
    Then POST /episodes {upload: key, trim?}. 501 without a bucket (the client sends the file to /episodes instead)."""
    if not STORE.on or not hasattr(STORE.store, "sign_put"):
        raise HTTPException(501, "direct uploads need a bucket; send the file to /episodes")
    body = await _json_body(request)
    if not isinstance(body, dict) or not isinstance(body.get("size"), int) or not isinstance(body.get("type"), str):
        raise HTTPException(400, "send {name, size, type}")
    if body["size"] <= 0 or body["size"] > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"videos up to {MAX_UPLOAD_MB} MB")
    if not body["type"].startswith(VIDEO_TYPES):
        raise HTTPException(415, "send a video file")
    if _uploads_mb() > MAX_STORE_MB:
        raise HTTPException(507, "This demo server is full for now. The samples still work.")
    ext = re.sub(r"[^a-z0-9]", "", Path(str(body.get("name") or "")).suffix.lower())[:5] or "mp4"
    key = f"incoming/{uuid.uuid4().hex}.{ext}"
    url, headers = await run_in_threadpool(STORE.store.sign_put, key, body["type"], MAX_UPLOAD_MB * 1024 * 1024)
    return {"key": key, "url": url, "headers": headers}


@app.post("/episodes")
async def create_episode(request: Request) -> dict:
    """A new episode from a video: multipart `file` (+ trim), or JSON {upload: key, trim} for a file already put in
    Cloud Storage through POST /uploads."""
    ctype = request.headers.get("content-type", "")
    if ctype.startswith("multipart/form-data"):
        size = request.headers.get("content-length")
        if not size or not size.isdigit() or int(size) > MAX_UPLOAD_MB * 1024 * 1024:
            raise HTTPException(413, f"videos up to {MAX_UPLOAD_MB} MB")
        if _uploads_mb() > MAX_STORE_MB:
            raise HTTPException(507, "This demo server is full for now. The samples still work.")
        held = _reserve(request, "upload", 0.0)
        form = await request.form()
        f = form.get("file")
        if f is None or not hasattr(f, "read"):
            raise HTTPException(400, "multipart field `file` required")
        ext = re.sub(r"[^a-z0-9]", "", Path(f.filename or "").suffix.lower()) or "mp4"
        episode_id = f"up-{uuid.uuid4().hex[:16]}"  # unguessable: an upload is reachable only through its own link
        out = OUT_ROOT / episode_id
        out.mkdir(parents=True, exist_ok=True)
        dest = out / f"source.{ext}"
        with dest.open("wb") as fh:
            shutil.copyfileobj(f.file, fh)
        trim = str(form.get("trim") or "").lower() in ("1", "true", "yes")
        return _start_episode(request, episode_id, dest, trim, held)
    if ctype.startswith("application/json"):
        body = await _json_body(request)
        key = body.get("upload") if isinstance(body, dict) else None
        if not isinstance(key, str) or not INCOMING_RE.match(key) or not STORE.on:
            raise HTTPException(400, "send {upload: key} from POST /uploads, or a multipart `file`")
        held = _reserve(request, "upload", 0.0)
        episode_id = f"up-{uuid.uuid4().hex[:16]}"
        out = OUT_ROOT / episode_id
        out.mkdir(parents=True, exist_ok=True)
        dest = out / f"source.{key.rsplit('.', 1)[1]}"
        if not await run_in_threadpool(STORE.store.get, key, dest):
            shutil.rmtree(out, ignore_errors=True)
            LIMITS.refund(held)
            raise HTTPException(404, "that upload is not in storage (it expires after a day); upload the video again")
        if dest.stat().st_size > MAX_UPLOAD_MB * 1024 * 1024:
            shutil.rmtree(out, ignore_errors=True)
            LIMITS.refund(held)
            raise HTTPException(413, f"videos up to {MAX_UPLOAD_MB} MB")
        result = _start_episode(request, episode_id, dest, bool(body.get("trim")), held)
        threading.Thread(target=lambda: STORE.store.delete(key), daemon=True).start()  # the episode has its own copy now
        return result
    raise HTTPException(415, "send a multipart `file` or {upload: key}")


def _start_episode(request: Request, episode_id: str, dest: Path, trim: bool, held) -> dict:
    """Probe the uploaded file, refuse it or keep the first MAX_SECONDS, and start ingest."""
    out = dest.parent
    try:
        duration = probe(dest)["duration"]
    except Exception:  # noqa: BLE001
        shutil.rmtree(out, ignore_errors=True)
        LIMITS.refund(held)
        raise HTTPException(415, "could not read that file as a video")
    if duration > MAX_SECONDS + 0.05 and not trim:
        shutil.rmtree(out, ignore_errors=True)
        LIMITS.refund(held)
        raise HTTPException(422, {"code": "too_long", "duration": round(duration, 2), "limit": MAX_SECONDS,
                                  "message": f"Videos up to {MAX_SECONDS:g} s. Send trim=1 to use the first {MAX_SECONDS:g} s."})
    job = Job(episode_id, dest)
    if duration > MAX_SECONDS + 0.05:
        job.trim_to = MAX_SECONDS
    JOBS[job.id] = job
    (out / "owner.json").write_text(json.dumps({"visitor": ops.visitor_of(request)}))
    threading.Thread(target=run_ingest, args=(job,), daemon=True).start()
    ops.record("upload", **ops.who(request), episode=episode_id, seconds=round(duration, 2), trimmed=bool(job.trim_to) or None,
               mb=round(dest.stat().st_size / 1e6, 1))
    return {"jobId": job.id, "episodeId": episode_id}


@app.post("/episodes/{episode_id}/rerun")
def episode_rerun(episode_id: str, request: Request) -> dict:
    eid = _valid_id(episode_id)
    if is_sample(eid):
        raise HTTPException(403, "samples are read-only")
    _require_owner(request, eid, "re-extract")
    if not (OUT_ROOT / eid / "ingest.json").is_file():
        raise HTTPException(404, "unknown episode")
    job = Job(eid, rerun=True)
    JOBS[job.id] = job
    threading.Thread(target=run_ingest, args=(job,), daemon=True).start()
    return {"jobId": job.id, "episodeId": eid}


_IDENTIFY_LLM = None


@app.post("/episodes/{episode_id}/identify")
async def episode_identify(episode_id: str, request: Request) -> dict:
    """A box drawn on Scenes: Cloud Vision snaps it to the object under it; Gemini names it in the scene's context and
    picks products per audience (cached)."""
    from .identify import identify

    global _IDENTIFY_LLM
    eid = await _valid_id_async(episode_id)
    body = await _json_body(request)
    if not isinstance(body, dict):
        raise HTTPException(400, "send {shotId, box: {x, y, w, h}, audiences: Audience[], catalog: CatalogProduct[]}")
    shot, box = body.get("shotId"), body.get("box") or {}
    if not isinstance(shot, str) or not re.match(r"^[A-Za-z0-9_-]+$", shot) or not isinstance(box, dict) or not all(
            isinstance(box.get(k), (int, float)) and not isinstance(box.get(k), bool) and 0 <= box[k] <= 1 for k in ("x", "y", "w", "h")):
        raise HTTPException(400, "send {shotId, box: {x, y, w, h} (0..1), audiences, catalog}")
    catalog, audiences = parse_catalog_body(body)
    if not (OUT_ROOT / eid).is_dir():
        raise HTTPException(404, "unknown episode")
    if _IDENTIFY_LLM is None:
        _IDENTIFY_LLM = get_llm(os.environ.get("CAMEO_API_LLM", "gemini"))
    _reserve(request, "identify", 0.005, eid)
    try:
        answer = await run_in_threadpool(identify, OUT_ROOT / eid, _IDENTIFY_LLM, shot, {k: float(box[k]) for k in ("x", "y", "w", "h")}, audiences, catalog)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    ops.record("identify", **ops.who(request), episode=eid, cost=0.005, label=answer.get("label"))
    return answer


@app.post("/episodes/{episode_id}/match")
async def episode_match(episode_id: str, request: Request) -> dict:
    """Stage 3 only, for a changed catalog or audience list: cost-gated (match needs_confirmation, then /jobs/{id}/confirm)."""
    eid = await _valid_id_async(episode_id)
    catalog, audiences = parse_catalog_body(await _json_body(request))
    out = OUT_ROOT / eid
    if not (out / "ingest.json").is_file():
        raise HTTPException(404, "unknown episode")
    llm_name = os.environ.get("CAMEO_API_LLM", "gemini")
    if not has_stage12(out, llm_name):
        raise HTTPException(409, "detection has not run on this episode yet")
    job = Job(eid, kind="match")
    job.catalog, job.audiences = catalog, audiences
    JOBS[job.id] = job
    prepare_match(job)
    return {"jobId": job.id}


def _warm_tracks(out: Path) -> None:
    """Track the new boxes in the background, so Scenes opens with them following the video (CPU only)."""
    from .tracking import detected_tracks

    def go():
        try:
            detected_tracks(out, json.loads((out / "scenes.json").read_text()).get("boxes") or [])
        except Exception:  # noqa: BLE001  (Scenes asks again; boxes stay put meanwhile)
            pass

    threading.Thread(target=go, daemon=True).start()


def _reserve(request: Request, kind: str, usd: float, episode: str | None = None):
    """Hold `usd` against the browser's, its network's and the server's ceilings for today; a refusal is recorded and raised."""
    w = ops.who(request)
    try:
        return LIMITS.reserve(w["visitor"], w["net"], kind, usd)
    except HTTPException as e:
        ops.record("refused", **w, episode=episode, what=kind, reason=str(e.detail)[:160])
        raise


RENDER_OWNERS: dict[str, str] = {}
RENDER_HELD: dict[str, object] = {}  # a render's reservation, given back if it fails


def _render_finished(out: Path, meta: dict) -> None:
    owner = RENDER_OWNERS.pop(meta["id"], None)
    held = RENDER_HELD.pop(meta["id"], None)
    if meta.get("status") != "done" and held is not None:
        LIMITS.refund(held)
    if meta.get("status") == "done":
        ops.record("render_done", "server", out.name, cost=meta.get("cost") or 0.0, owner=owner, render=meta["id"],
                   seconds=meta.get("renderSeconds"), passed=(meta.get("verify") or {}).get("pass"), shot=meta.get("shotId"))
    else:
        ops.record("render_failed", "server", out.name, owner=owner, render=meta["id"], error=(meta.get("error") or "")[:200])


def _hook_renders() -> None:
    from . import render

    render.ON_FINISH = _render_finished


_hook_renders()


def _hook_gemini_errors() -> None:
    """A Gemini error inside a request (identify, prompts) answers as JSON with CORS headers, not a bare 500 the browser
    reads as an outage: 503 with a plain message when Vertex is out of capacity (429), else 502."""
    try:
        from google.genai import errors
    except ImportError:  # tests without the SDK
        return

    @app.exception_handler(errors.APIError)
    async def gemini_error(_request: Request, e: Exception) -> JSONResponse:
        if busy(e):
            return JSONResponse({"detail": BUSY_MESSAGE}, status_code=503)
        return JSONResponse({"detail": f"Gemini could not answer: {str(e)[:200]}"}, status_code=502)


_hook_gemini_errors()


def _uploads_mb() -> float:
    return sum(f.stat().st_size for d in OUT_ROOT.glob("up-*") if not (d / "sample.json").is_file() for f in d.rglob("*") if f.is_file()) / 1e6


def _require_owner(request: Request, eid: str, verb: str) -> None:
    """Only the browser that uploaded an episode may change what it is; anyone with its link can still open it."""
    p = OUT_ROOT / eid / "owner.json"
    try:
        owner = json.loads(p.read_text()).get("visitor")
    except (OSError, ValueError):
        return
    if owner and owner != ops.visitor_of(request):
        raise HTTPException(403, f"Only the browser that uploaded this video can {verb} it.")


def is_sample(eid: str) -> bool:
    return (OUT_ROOT / eid / "sample.json").is_file()


@app.get("/episodes/{episode_id}/tracks")
async def episode_tracks(episode_id: str) -> dict:
    """Where each of Gemini's boxes is through its shot (tracking.py; CPU only, cached): {boxId: track}. A re-match
    changes products, never boxes, so the original run's boxes are the ones tracked."""
    from .tracking import detected_tracks

    eid = await _valid_id_async(episode_id)
    out = OUT_ROOT / eid
    sp = out / "scenes.json"
    if not (out / "ingest.json").is_file() or not sp.is_file():
        raise HTTPException(404, "no detection for this episode yet")
    boxes = json.loads(sp.read_text()).get("boxes") or []
    return await run_in_threadpool(detected_tracks, out, boxes)


@app.post("/episodes/{episode_id}/track")
async def episode_track(episode_id: str, request: Request) -> dict:
    """A box drawn on Scenes, through its shot from the frame it was drawn on: {shotId, t, box} -> track."""
    from .tracking import box_track

    eid = await _valid_id_async(episode_id)
    body = await _json_body(request)
    box = body.get("box") if isinstance(body, dict) else None
    shot, t = (body.get("shotId"), body.get("t")) if isinstance(body, dict) else (None, None)
    if not isinstance(shot, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", shot) or not isinstance(t, (int, float)) or not isinstance(box, dict) or not all(
            isinstance(box.get(k), (int, float)) and 0 <= box[k] <= 1 for k in ("x", "y", "w", "h")):
        raise HTTPException(400, "send {shotId, t, box: {x, y, w, h} (0..1)}")
    if not (OUT_ROOT / eid / "ingest.json").is_file():
        raise HTTPException(404, "unknown episode")
    try:
        return await run_in_threadpool(box_track, OUT_ROOT / eid, shot, [(float(t), box)], [], float(t))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.get("/samples")
def samples() -> list[dict]:
    """Ready-made episodes (out/<id>/sample.json, written by scripts/make_sample.py), in their set order."""
    found = []
    for f in OUT_ROOT.glob("*/sample.json"):
        try:
            m = json.loads(f.read_text())
            ing = json.loads((f.parent / "ingest.json").read_text())
        except (OSError, ValueError):  # one broken or half-written sample never hides the others
            continue
        poster = next((v.get("poster") for v in m.get("versions", []) if v.get("poster")), None)
        shown = next((v for v in m.get("versions", []) if v.get("renderId")), None)  # the version the card plays
        found.append({"id": f.parent.name, "name": m["name"], "blurb": m.get("blurb", ""), "order": m.get("order", 99),
                      "duration": ing["duration"], "width": ing["width"], "height": ing["height"], "shots": len(ing["shots"]),
                      "versions": len(m.get("versions", [])), "products": len({a["productId"] for v in m.get("versions", []) for a in v["assignments"]}),
                      "poster": poster, "clip": f"/episodes/{f.parent.name}/renders/{shown['renderId']}.mp4" if shown else None,
                      "original": f"/episodes/{f.parent.name}/clips/{shown['shotId']}.mp4" if shown else None})
    return sorted(found, key=lambda x: (x["order"], x["name"]))


@app.get("/episodes/{episode_id}/sample")
def episode_sample(episode_id: str) -> dict:
    p = OUT_ROOT / _valid_id(episode_id) / "sample.json"
    if not p.is_file():
        raise HTTPException(404, "not a sample")
    return json.loads(p.read_text())


@app.delete("/episodes/{episode_id}")
def episode_delete(episode_id: str, request: Request) -> dict:
    """Remove an episode and everything made from it (source, proxy, keyframes, caches, previews, renders, events).
    Running jobs for it are cancelled. Samples are read-only."""
    eid = _valid_id(episode_id)
    if is_sample(eid):
        raise HTTPException(403, "samples are read-only")
    _require_owner(request, eid, "remove")
    for job in list(JOBS.values()):
        if job.episode_id == eid and job.state not in TERMINAL:
            job.cancel_flag.set()
            job.emit("job", "cancelled", "Episode removed")
    out = OUT_ROOT / eid
    existed = out.is_dir()
    if existed:
        shutil.rmtree(out, ignore_errors=True)
    STORE.forget(eid)
    return {"ok": True, "deleted": existed}


@app.post("/episodes/{episode_id}/prompt")
async def episode_prompt(episode_id: str, request: Request) -> dict:
    """Gemini writes the edit prompt for a product the producer put in a box: body {shotId, box, label, kind, product}."""
    from .identify import write_prompt

    global _IDENTIFY_LLM
    eid = await _valid_id_async(episode_id)
    body = await _json_body(request)
    if not isinstance(body, dict):
        raise HTTPException(400, "send {shotId, box: {x, y, w, h}, label, kind, product: {brand, name, category, description}}")
    shot, box, product = body.get("shotId"), body.get("box") or {}, body.get("product") or {}
    if not isinstance(box, dict) or not isinstance(product, dict):
        raise HTTPException(400, "box and product must be objects")
    if not isinstance(shot, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", shot) or not all(isinstance(box.get(k), (int, float)) for k in ("x", "y", "w", "h")) or not product.get("name"):
        raise HTTPException(400, "send {shotId, box: {x, y, w, h}, label, kind, product: {brand, name, category, description}}")
    if _IDENTIFY_LLM is None:
        _IDENTIFY_LLM = get_llm(os.environ.get("CAMEO_API_LLM", "gemini"))
    if not hasattr(_IDENTIFY_LLM, "_generate"):
        raise HTTPException(501, "writing prompts needs the gemini LLM")
    keep = {k: product.get(k) for k in ("brand", "name", "category", "description")}
    _reserve(request, "prompt", 0.002, eid)
    try:
        text = await run_in_threadpool(write_prompt, OUT_ROOT / eid, _IDENTIFY_LLM, shot, box, str(body.get("label") or "spot")[:200], str(body.get("kind") or "")[:40], keep)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    ops.record("prompt", **ops.who(request), episode=eid, cost=0.002, product=f"{keep.get('brand') or ''} {keep.get('name') or ''}".strip())
    return {"prompt": text}


@app.get("/episodes/{episode_id}")
def episode_info(episode_id: str) -> dict:
    eid = _valid_id(episode_id)
    d = OUT_ROOT / eid
    if not (d / "ingest.json").is_file():
        raise HTTPException(404, "unknown episode")
    ing = load_ingest(d)
    return {"episodeId": eid, "sample": is_sample(eid), "hasDetected": (d / "web.json").exists(), "duration": ing.duration, "shots": len(ing.shots)}


def _sse(job: Job) -> Iterator[str]:
    i = 0
    last = time.monotonic()
    while True:
        with job.cond:
            while i >= len(job.events) and time.monotonic() - last < PING_EVERY:
                job.cond.wait(timeout=1.0)
            batch = job.events[i:]
        if not batch:
            yield ": ping\n\n"
            last = time.monotonic()
            continue
        for ev in batch:
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
            i += 1
            if ev["stage"] == "job" and ev["state"] in TERMINAL:
                return
        last = time.monotonic()


@app.get("/jobs/{job_id}/events")
def job_events(job_id: str) -> StreamingResponse:
    job = get_job(job_id)
    return StreamingResponse(_sse(job), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/jobs/{job_id}")
def job_summary(job_id: str) -> dict:
    return get_job(job_id).summary()


@app.post("/jobs/{job_id}/confirm")
async def job_confirm(job_id: str, request: Request) -> dict:
    """Body {catalog, audiences}: stage 3 matches against them. A match job already has them (a body here replaces them);
    detection needs the body."""
    job = get_job(job_id)
    if job.state != "awaiting_confirmation":
        raise HTTPException(409, f"job is {job.state}, not waiting for confirmation")
    body = await _json_body(request)
    catalog = audiences = None
    if body is not None and not (isinstance(body, dict) and not body):
        catalog, audiences = parse_catalog_body(body)
    elif job.kind == "detect":
        raise HTTPException(400, "send {catalog: CatalogProduct[], audiences: Audience[]}")
    with job.cond:  # checked and reserved together: a double click pays once
        if job.state != "awaiting_confirmation":
            raise HTTPException(409, f"job is {job.state}, not waiting for confirmation")
        _reserve(request, "detect" if job.kind == "detect" else "match", job.estimate, job.episode_id)
        job.state = "running"
        job.who = ops.who(request)
        if catalog is not None:
            job.catalog, job.audiences = catalog, audiences
    threading.Thread(target=run_match if job.kind == "match" else run_detection, args=(job,), daemon=True).start()
    return job.summary()


@app.post("/jobs/{job_id}/cancel")
def job_cancel(job_id: str) -> dict:
    job = get_job(job_id)
    if job.state in TERMINAL:
        raise HTTPException(409, f"job already {job.state}")
    job.cancel_flag.set()
    job.emit("job", "cancelled", "Cancelled")
    return job.summary()


@app.get("/episodes/{episode_id}/detected.json")
def episode_detected(episode_id: str, match: str | None = None) -> dict:
    """The original detection run by default (no param or ?match=); ?match=<matchId> serves that re-match."""
    d = OUT_ROOT / _valid_id(episode_id)
    if not (d / "web.json").exists():
        raise HTTPException(404, "no detection output yet")
    if match:
        if not re.match(r"^[a-f0-9]{12}$", match) or not (d / "match" / match / "web.json").is_file():
            raise HTTPException(404, "unknown match")
    return build_detected(d, match)


@app.get("/episodes/{episode_id}/media/proxy")
def episode_proxy(episode_id: str) -> FileResponse:
    p = OUT_ROOT / _valid_id(episode_id) / "proxy_360p.mp4"
    if not p.is_file():
        raise HTTPException(404, "no proxy")
    return FileResponse(p, media_type="video/mp4")  # Starlette >= 0.39 answers Range requests


@app.get("/config")
def config() -> dict:
    """What the web app shows before it spends anything: the upload limit, the generation models and their prices."""
    from . import preview, render

    on = os.environ.get("CAMEO_IMAGE", "gemini") != "off"
    video_on = os.environ.get("CAMEO_VIDEO", "gemini") != "off"
    return {"maxSeconds": MAX_SECONDS, "budget": LIMITS.status(), "imageModel": preview.IMAGE_MODEL if on else None, "imagePrice": preview.PRICE_PER_IMAGE,
            "videoModel": render.OMNI_MODEL if video_on else None, "videoPricePerSecond": render.PRICE_PER_S}


@app.post("/episodes/{episode_id}/previews")
async def episode_preview(episode_id: str, request: Request) -> dict:
    """One scene version's keyframe edited by Nano Banana with its products in place (cached; one image when not)."""
    from pydantic import ValidationError

    from . import preview

    eid = await _valid_id_async(episode_id)
    out = OUT_ROOT / eid
    if not (out / "ingest.json").is_file():
        raise HTTPException(404, "unknown episode")
    try:
        req = preview.PreviewRequest.model_validate(await _json_body(request, 40_000_000))  # product photos travel inline
    except ValidationError as e:
        raise HTTPException(400, f"bad preview request: {e.errors()[0]['loc']} {e.errors()[0]['msg']}")
    backend = preview.get_image_backend()
    if backend is None:
        raise HTTPException(503, "image generation is off on this server")
    held = _reserve(request, "preview", preview.PRICE_PER_IMAGE, eid)
    try:
        r = await run_in_threadpool(preview.generate, out, req, backend)
    except FileNotFoundError as e:
        LIMITS.refund(held)
        raise HTTPException(404, str(e))
    except (ValueError, preview.ImageError) as e:
        LIMITS.refund(held)
        raise HTTPException(422, f"Nano Banana did not return an image: {e}")
    except BaseException:
        LIMITS.refund(held)
        raise
    if r["cached"]:
        LIMITS.refund(held)
    ops.record("preview", **ops.who(request), episode=eid, cost=0.0 if r["cached"] else r["cost"], cached=r["cached"] or None,
               model=r["model"], seconds=r["seconds"], audience=req.audienceId, shot=req.shotId)
    return {"id": r["id"], "url": f"/episodes/{eid}/previews/{r['id']}.png", "model": r["model"], "seconds": r["seconds"], "cost": 0.0 if r["cached"] else r["cost"], "cached": r["cached"]}


@app.post("/episodes/{episode_id}/renders")
async def episode_render(episode_id: str, request: Request) -> dict:
    """Render one scene version with Gemini Omni (runs in the background; poll GET .../renders/{id}). Cached by inputs."""
    from pydantic import ValidationError

    from . import render

    out = OUT_ROOT / await _valid_id_async(episode_id)
    if not (out / "ingest.json").is_file():
        raise HTTPException(404, "unknown episode")
    try:
        req = render.RenderRequest.model_validate(await _json_body(request))
    except ValidationError as e:
        raise HTTPException(400, f"bad render request: {e.errors()[0]['loc']} {e.errors()[0]['msg']}")
    backend = render.get_video_backend()
    if backend is None:
        raise HTTPException(503, "video rendering is off on this server")
    if len(render._ACTIVE) >= MAX_RENDERS:
        raise HTTPException(429, "Gemini Omni is busy with other renders. Try again in a minute.")
    t0 = time.time()
    held = _reserve(request, "render", MAX_SECONDS * render.PRICE_PER_S[req.resolution] + 0.01, out.name)
    try:
        meta = await run_in_threadpool(render.start, out, req, backend)
    except FileNotFoundError as e:
        LIMITS.refund(held)
        raise HTTPException(409, str(e))
    if meta.get("startedAt", 0) < t0:  # an earlier render of the same request: nothing new to pay for
        LIMITS.refund(held)
    else:
        RENDER_OWNERS[meta["id"]] = ops.visitor_of(request)
        RENDER_HELD[meta["id"]] = held
        ops.record("render_start", **ops.who(request), episode=out.name, render=meta["id"], estimate=meta.get("estimate"), shot=req.shotId,
                   audience=req.audienceId, attempt=req.attempt)
    return _render_view(episode_id, meta)


def _render_view(episode_id: str, meta: dict) -> dict:
    keep = ("id", "status", "stage", "shotId", "audienceId", "stillId", "attempt", "resolution", "seconds", "estimate", "cost", "renderSeconds", "verify", "error", "continuity", "startedAt")
    view = {k: meta[k] for k in keep if k in meta}
    if meta.get("status") == "done":
        view["url"] = f"/episodes/{episode_id}/renders/{meta['id']}.mp4"
    return view


@app.get("/episodes/{episode_id}/renders/{name}")
def episode_render_get(episode_id: str, name: str):
    from . import render

    out = OUT_ROOT / _valid_id(episode_id)
    if re.fullmatch(r"[0-9a-f]{20}\.(mp4|jpg)", name):  # the clip, or its poster frame
        p = out / "renders" / name
        if not p.is_file():
            raise HTTPException(404, "no such render")
        kind = "image/jpeg" if name.endswith(".jpg") else "video/mp4"
        return FileResponse(p, media_type=kind, headers={"Cache-Control": "public, max-age=31536000, immutable"})
    if not re.fullmatch(r"[0-9a-f]{20}", name):
        raise HTTPException(400, "bad id")
    meta = render.read(out, name)
    if meta is None:
        raise HTTPException(404, "no such render")
    return _render_view(episode_id, meta)


@app.get("/episodes/{episode_id}/clips/{name}")
def episode_clip(episode_id: str, name: str) -> FileResponse:
    """A shot's original clip (Omni's input), for the Original side of the comparison."""
    from . import render

    m = re.fullmatch(r"([A-Za-z0-9_-]+)\.mp4", name)
    if not m:
        raise HTTPException(400, "bad name")
    out = OUT_ROOT / _valid_id(episode_id)
    try:
        p, _ = render.clip_for(out, m.group(1))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    return FileResponse(p, media_type="video/mp4")


@app.post("/episodes/{episode_id}/masters")
async def episode_master(episode_id: str, request: Request) -> dict:
    """The episode for one audience with its rendered shots cut in: body {audienceId, renders: [id]}."""
    from . import render

    eid = await _valid_id_async(episode_id)
    body = await _json_body(request)
    if not isinstance(body, dict) or not isinstance(body.get("renders") or [], list):
        raise HTTPException(400, "send {audienceId, renders: [id]}")
    aud, ids = body.get("audienceId"), [r for r in body.get("renders") or [] if isinstance(r, str) and re.fullmatch(r"[0-9a-f]{20}", r)]
    if not isinstance(aud, str) or not ids:
        raise HTTPException(400, "send {audienceId, renders: [id]}")
    if not (OUT_ROOT / eid / "ingest.json").is_file():
        raise HTTPException(404, "unknown episode")
    p = await run_in_threadpool(render.master, OUT_ROOT / eid, aud, ids)
    return {"url": f"/episodes/{eid}/masters/{p.name}"}


@app.get("/episodes/{episode_id}/masters/{name}")
def episode_master_file(episode_id: str, name: str) -> FileResponse:
    """A master (.mp4) or its poster (.jpg, the first frame)."""
    if not re.fullmatch(r"[0-9a-f]{20}\.(mp4|jpg)", name):
        raise HTTPException(400, "bad name")
    p = OUT_ROOT / _valid_id(episode_id) / "masters" / name
    if not p.is_file():
        raise HTTPException(404, "no such master")
    return FileResponse(p, media_type="image/jpeg" if name.endswith(".jpg") else "video/mp4")


@app.get("/episodes/{episode_id}/refs/{name}")
def episode_ref(episode_id: str, name: str) -> FileResponse:
    """A product photo kept from a preview request (a sample's custom products show it)."""
    m = re.fullmatch(r"[0-9a-f]{20}\.(png|jpg|webp)", name)
    if not m:
        raise HTTPException(400, "bad name")
    p = OUT_ROOT / _valid_id(episode_id) / "refs" / name
    if not p.is_file():
        raise HTTPException(404, "no such photo")
    return FileResponse(p, media_type={"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}[m.group(1)])


@app.get("/episodes/{episode_id}/previews/{name}")
def episode_preview_file(episode_id: str, name: str) -> FileResponse:
    if not re.fullmatch(r"[0-9a-f]{20}\.png", name):
        raise HTTPException(400, "bad name")
    p = OUT_ROOT / _valid_id(episode_id) / "previews" / name
    if not p.is_file():
        raise HTTPException(404, "no such preview")
    return FileResponse(p, media_type="image/png", headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/episodes/{episode_id}/media/keyframes/{name}")
def episode_keyframe(episode_id: str, name: str) -> FileResponse:
    if not NAME_RE.match(name):
        raise HTTPException(400, "bad name")
    p = OUT_ROOT / _valid_id(episode_id) / "keyframes" / name
    if not p.is_file():
        raise HTTPException(404, "no such keyframe")
    return FileResponse(p, media_type="image/jpeg")
