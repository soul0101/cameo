"""Gemini on Vertex AI for detection. Everything the pipeline asks a model goes through `LLM`.

- `GeminiLLM`: Gemini 3.8 Flash through the `google-genai` SDK on Vertex AI (GOOGLE_GENAI_USE_VERTEXAI=true,
  GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION default `global`, one retry in us-central1; credentials from ADC).
  Stage 1 reads the whole episode as video, stage 2 boxes surfaces on keyframes, stage 3 matches products per audience
  in one call; every call uses structured output (a Pydantic response schema).
- `DryRunGeminiLLM`: builds the same requests and writes them to <out>/requests/ without calling the API.
- `MockLLM`: an offline stand-in with fixed data, for tests and keyless runs.
"""

from __future__ import annotations

import json
import math
import os
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field

from . import mock_data
from .schemas import (
    INTERACTION_RULE,
    VISIBILITY_RULE,
    Box,
    CameraMotion,
    Keyframe,
    LocalisedFrame,
    NormBox,
    Product,
    ProductSuggestion,
    RuleSet,
    SceneRerank,
    SceneUnderstanding,
    SensitivityLevel,
    Shot,
    Suggestion,
    Surface,
    SurfaceKind,
)


class LLM(ABC):
    name = "llm"

    @abstractmethod
    def understand_scenes(self, proxy: Path, shots: list[Shot]) -> list[SceneUnderstanding]:
        """Stage 1: one low-resolution video call for the whole episode (or chunk)."""

    @abstractmethod
    def localise(self, keyframe: Keyframe, image: Path, surfaces: list[Surface], objects: Optional[list[dict]] = None) -> LocalisedFrame:
        """Stage 2: boxes (+ masks) for the named surfaces, plus face boxes (kind="face"), in one keyframe.
        `objects`: Cloud Vision objects found on this keyframe (context for the prompt)."""

    def match_episode(self, scenes: list[SceneUnderstanding], boxes: list[Box], catalog: list[Product], rules: RuleSet, regions: list[str], tag: str = "episode") -> list[SceneRerank]:
        """Stage 3: ONE call for the episode (or a chunk of scenes): up to 3 products per (box, audience), why, default prompt.
        `regions` are audience ids (free strings); `catalog` has one Product per (product, eligible audience), region = audience id."""
        raise NotImplementedError

    def identify_box(self, image: Path, prompt: str, ctx: dict) -> dict:
        """One drawn box: {label, kind, why, picks: [{audienceId, products: [{productId, why}], prompt}]} (identify.py validates it)."""
        raise NotImplementedError


def default_prompt(box: Box, product: Product) -> str:
    """House style: name the surface, the product, and what must stay identical."""
    keep = "keep the hands, lighting and reflections identical" if box.occludedByHands > 0 else "keep the people, lighting and camera move identical"
    label = box.label.lower()
    if box.kind == "apparel":
        return f"Replace the {label} with {product.name} in the same fit; keep the face, body, pose and the lighting identical."
    if box.kind in ("wall", "sign"):
        return f"Hang a framed {product.name} poster on the {label}, unobstructed; {keep}."
    if box.kind == "screen":
        return f"Show {product.name} on the {label}; {keep}."
    if box.kind == "hand":
        return f"Replace the {label} with {product.name}, label facing the camera; {keep}."
    return f"Place {product.name} on the {label} where the camera sees it clearly, front facing the camera; {keep}."


# ================================================================ Offline stand-in


def _shot_index(t: float, shot_seconds: float = 8.0) -> int:
    return max(0, min(len(mock_data.SCENES) - 1, int(t // shot_seconds)))


class MockLLM(LLM):
    """Fixed scenes, boxes and picks keyed by time (8 s shots), so the pipeline and tests run without a key."""

    name = "mock"

    def understand_scenes(self, proxy: Path, shots: list[Shot]) -> list[SceneUnderstanding]:
        out = []
        for s in shots:
            d = mock_data.SCENES[_shot_index((s.tIn + s.tOut) / 2)]
            out.append(SceneUnderstanding.model_validate({**d, "shotId": s.shotId, "tIn": s.tIn, "tOut": s.tOut}))
        return out

    def localise(self, keyframe: Keyframe, image: Path, surfaces: list[Surface], objects: Optional[list[dict]] = None) -> LocalisedFrame:
        d = mock_data.BOXES[_shot_index(keyframe.t)]
        boxes, masks = [], {}
        for s in surfaces:
            if s.label not in d:
                continue
            spec = d[s.label]
            b = NormBox(**spec["box"])
            boxes.append(Box(label=s.label, kind=s.kind, box=b, t=keyframe.t, shotId=keyframe.shotId, occludedByHands=spec.get("occludedByHands", 0.0), textPresent=spec.get("textPresent", s.hasText), salience=spec.get("salience")))
            masks[s.label] = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]]
        for i, f in enumerate(d["faces"]):
            boxes.append(Box(label=f"face {i + 1}", kind="face", box=NormBox(**f), t=keyframe.t, shotId=keyframe.shotId))
        return LocalisedFrame(boxes=boxes, masks=masks)

    def _picks(self, scene: SceneUnderstanding, boxes: list[Box], candidates: dict[str, dict[str, list[Product]]]) -> SceneRerank:
        idx = _shot_index((scene.tIn + scene.tOut) / 2)
        sugs, notes = [], {}
        for b in boxes:
            line, fit, why, note = mock_data.PICKS.get((idx, b.label), ("", 0.5, "", b.label))
            notes[b.id] = note
            for region, prods in candidates.get(b.id, {}).items():
                hand = next((p for p in prods if line and p.line == line), None)
                picked = [ProductSuggestion(productId=hand.id, fit=fit, why=why)] if hand else []
                rest = [ProductSuggestion(productId=p.id, fit=round(max(0.05, fit - 0.2 - 0.05 * i), 2), why=f"{p.category} fits the {scene.scene.type}") for i, p in enumerate(prods) if p is not hand][:2 if hand else 3]
                top = hand or (prods[0] if prods else None)
                if top is None:
                    continue
                sugs.append(Suggestion(boxId=b.id, region=region, suggestions=picked + rest, defaultPrompt=default_prompt(b, top)))
        return SceneRerank(shotId=scene.shotId, boxNotes=notes, suggestions=sugs)

    def match_episode(self, scenes: list[SceneUnderstanding], boxes: list[Box], catalog: list[Product], rules: RuleSet, regions: list[str], tag: str = "episode") -> list[SceneRerank]:
        out = []
        for sc in scenes:
            mine = [b for b in boxes if b.shotId == sc.shotId and not b.blocked]
            if mine:
                out.append(self._picks(sc, mine, {b.id: {r: [p for p in catalog if p.region == r] for r in regions} for b in mine}))
        return out

    def identify_box(self, image: Path, prompt: str, ctx: dict) -> dict:
        """Tests only: names the box after the nearest Vision object and picks the first eligible products."""
        objs = ctx.get("objects") or []
        label = objs[0] if objs else "Selected area"
        return {"label": label, "kind": "other", "edit": "place", "why": f"{label} in this scene.",
                "picks": [{"audienceId": a, "products": [{"productId": i, "why": "Eligible here."} for i in ids[:3]], "prompt": f"Place {ids[0]} on the {label.lower()}; keep the people, lighting and camera move identical." if ids else ""}
                          for a, ids in ctx["eligible"].items()]}


# ================================================================ Gemini on Vertex AI

DEFAULT_LOCATION = "global"
FALLBACK_LOCATION = "us-central1"
INLINE_MAX_BYTES = 20 * 1024 * 1024  # Vertex inline request limit; a larger proxy goes through gs://
PRICE_PER_M = {"input": 0.75, "output": 3.75, "cached": 0.075}  # USD per million tokens, Gemini 3.8 Flash list price
VIDEO_TOKENS_PER_S_LOW = 98  # 66 tokens per frame at 1 fps + 32 tokens per second of audio, for budgeting
MATCH_MAX_OUTPUT = 16384  # stage 3 output budget (thinking tokens would count against it too)
IMAGE_TOKENS_ASSUMED = 1120  # default Gemini 3 image budget, for budgeting
BUSY_MESSAGE = "Gemini is busy right now (Vertex AI capacity). Try again in a minute."


def busy(e: BaseException) -> bool:
    """A 429 RESOURCE_EXHAUSTED from Vertex AI: shared capacity was full for a moment."""
    return getattr(e, "code", None) == 429 or "RESOURCE_EXHAUSTED" in str(e)


def with_backoff(call, tries: int = 4, first: float = 8.0):
    """Retry a Vertex call on 429 with truncated exponential backoff and jitter (about 8, 16, 32 s), as Google
    recommends for shared capacity; any other error is raised at once."""
    import random
    import time

    wait = first
    for i in range(tries):
        try:
            return call()
        except Exception as e:  # noqa: BLE001
            if i == tries - 1 or not busy(e):
                raise
            time.sleep(wait * random.uniform(0.75, 1.25))
            wait *= 2
# Hedged keyframe calls: most stage-2 calls answer in 7 to 18 s, but about one in six stalls for 60 to 100 s on the
# service side (same size answer, one 200 response, no retry). A call still waiting after this long is sent again
# and the first answer wins, so one straggler no longer sets the whole stage's time.
HEDGE_AFTER_S = 20.0


def vertex_settings(env: Optional[dict] = None) -> dict:
    """Vertex config from env: GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION (default global)."""
    env = os.environ if env is None else env
    return {
        "vertexai": str(env.get("GOOGLE_GENAI_USE_VERTEXAI", "")).strip().lower() in ("1", "true", "yes"),
        "project": (env.get("GOOGLE_CLOUD_PROJECT") or "").strip() or None,
        "location": (env.get("GOOGLE_CLOUD_LOCATION") or "").strip() or DEFAULT_LOCATION,
    }


def make_vertex_client(project: Optional[str] = None, location: Optional[str] = None, env: Optional[dict] = None):
    """`genai.Client(vertexai=True, project=..., location=...)`; credentials come from ADC on the first request."""
    from google import genai

    s = vertex_settings(env)
    if not s["vertexai"]:
        raise SystemExit("--llm gemini runs on Vertex AI: set GOOGLE_GENAI_USE_VERTEXAI=true (see agents/.env.example)")
    project = project or s["project"]
    if not project:
        raise SystemExit("--llm gemini needs GOOGLE_CLOUD_PROJECT (see agents/.env.example)")
    return genai.Client(vertexai=True, project=project, location=location or s["location"])


def is_location_error(e: Exception) -> bool:
    """A 'model not found / not supported in this location' error, which is worth one retry in us-central1."""
    code = getattr(e, "code", None)
    msg = (getattr(e, "message", None) or str(e)).lower()
    if code == 404 or "not_found" in msg:
        return True
    return code == 400 and any(w in msg for w in ("location", "region")) and any(w in msg for w in ("not supported", "not available", "not found", "unsupported"))


# ---------- model-facing schemas (no pipeline-only fields; the code adds blocked and ids itself)


class _GSceneInfo(BaseModel):
    type: str = Field(description="scene type, e.g. café, street, apartment, shop, office")
    mood: str = Field(description="a few words, e.g. 'warm, playful' or 'sad'")
    tags: list[str] = Field(description="short visual tags: time of day, framing, light")


class _GPeople(BaseModel):
    count: int = Field(description="people visible in the shot")
    facesVisible: int = Field(description="faces clearly visible")


class _GSensitivity(BaseModel):
    level: SensitivityLevel = Field(description="none | low | medium | high | critical")
    reasons: list[str] = Field(description="why, in one short sentence each; empty when level is none")


class _GSurface(BaseModel):
    label: str = Field(description="the surface in plain words, e.g. 'plain white cup on the table'")
    kind: SurfaceKind
    timeVisible: float = Field(description="seconds the surface is visible in this shot")
    nearFace: bool = Field(description="the surface is next to or overlapping a face")
    hasText: bool = Field(description="the surface already carries text or a logo")


class _GSetup(BaseModel):
    tIn: float = Field(description="start, seconds from the start of the video")
    tOut: float = Field(description="end, seconds")
    angle: str = Field(description="short label of the camera setup, e.g. 'A: wide, table and window'. Reuse the SAME label every time the video returns to the same angle")
    spots: list[str] = Field(description="labels of this shot's surfaces that are visible in this stretch")
    motion: Literal["low", "medium", "high"] = Field(description="camera and subject motion in this stretch")


class _GShot(BaseModel):
    shotId: str
    tIn: float
    tOut: float
    scene: _GSceneInfo
    people: _GPeople
    cameraMotion: CameraMotion
    sensitivity: _GSensitivity
    surfaces: list[_GSurface]
    dialogueCues: list[str] = Field(description="lines heard in the audio that suggest a product category")
    sceneGroup: str = Field(description="short label of the place and moment, e.g. 'café, morning'; shots of the same scene share it exactly")
    setups: list[_GSetup] = Field(description="the shot split wherever the camera setup or framing changes (one entry when it never does), in order, covering tIn to tOut")


class _GShots(BaseModel):
    shots: list[_GShot]


class _GBox(BaseModel):
    label: str = Field(description="exactly one of the surface labels given, or 'face'")
    box_2d: list[int] = Field(min_length=4, max_length=4, description="[ymin, xmin, ymax, xmax] normalised to 0-1000")
    mask: Optional[list[list[int]]] = Field(None, description="optional segmentation polygon of [x, y] points, 0-1000, inside the box")
    occluded: float = Field(description="0-1 share of the surface hidden by hands or objects")
    nearFace: bool = Field(description="the surface touches or is next to a face")
    hasText: bool = Field(description="the surface carries text or a logo")


_GBOX_LIST = list[_GBox]


SCENE_PROMPT = """You are Scout, a product-placement analyst. The video is one episode. Its shots (from a cut detector) are:
{shots}
Return exactly one entry per shot, using the given shotId, tIn and tOut. For each shot report:
- scene: type (café, street, apartment, shop, ...), mood, and short visual tags;
- people: how many people are visible and how many faces are clearly visible;
- cameraMotion: static, pan, tilt, dolly, handheld or zoom;
- sensitivity: level none, low, medium, high or critical, with reasons. Rate high or critical for grief, bad news, sadness,
  disappointment or any visible emotional distress, violence, minors in risky contexts, medical distress, or alcohol near minors. Only rate; do not decide placement;
- surfaces: every spot that could carry a product, in plain words. Three sorts: objects that could be swapped for a
  product (a white mug in her hand, a plain bag, a laptop, a bottle, a phone, a person's plain shirt or jacket); empty
  surfaces a product could sit on (a café table, a counter, a shelf, an empty chair); and flat areas that can show an
  image (a blank wall, a billboard, a sign, a screen). Give kind (table, wall, sign, screen, shelf, hand for a held
  object, counter, vehicle, or apparel for clothing), seconds visible, whether it is near a face, and whether it
  already carries text. Keep to spots a viewer would notice: in frame for most of the shot, big enough to read, not
  blurred or mostly hidden. List them even in sensitive shots;
- dialogueCues: lines heard in the audio that suggest a product category (e.g. "you have to try this");
- sceneGroup: the place and moment as a short label; every shot of the same scene uses exactly the same label;
- setups: the shot split wherever the camera setup or framing changes even without a cut (a pan to a new view, a
  reframe, a new subject), in order and covering the whole shot. Give each a short angle label and reuse the same
  label whenever the video returns to the same angle (shot / reverse-shot editing), the visible surfaces, and the motion."""

LOCALISE_PROMPT = """Locate these surfaces in the image, and also every human face.
Surfaces (label and kind): {labels}
Objects Cloud Vision found in this frame (name, score, box as 0-1 x/y/w/h; context only, may be incomplete): {objects}
Return a JSON list with one object per surface you can see (label = the exact surface label above) and one per face
(label = "face"). Skip surfaces that are not visible. Box each surface tightly around the part that would carry the
product: the tabletop, not the legs; the clear part of a wall, not the whole room; the garment, not the person. Each object has:
- box_2d: [ymin, xmin, ymax, xmax] normalised to 0-1000;
- mask: a segmentation polygon of [x, y] points normalised to 0-1000 (omit for faces);
- occluded: 0-1, the share of the surface hidden by hands or objects;
- nearFace: whether the surface touches or is next to a face;
- hasText: whether the surface carries text or a logo."""


class _GNote(BaseModel):
    boxId: str
    note: str


class _GPick(BaseModel):
    productId: str = Field(description="a product id listed for THIS audience")
    why: str = Field(description="one short line (max 12 words) on why it fits this surface and scene")


class _GMatchRow(BaseModel):
    boxId: str
    regionId: str = Field(description="the audience id")
    suggestions: list[_GPick] = Field(description="up to 3, best first, with alternatives whenever they fit; empty when nothing for this audience fits")
    defaultPrompt: str = Field(description="edit prompt for the top suggestion in the house style; empty when no suggestions")


class _GMatch(BaseModel):
    boxNotes: list[_GNote] = Field(description="one line per box on why the surface suits a product")
    matches: list[_GMatchRow] = Field(description="one row per (boxId, regionId) for every matchable box and every audience")


# Shared by the match and identify prompts: how a product may appear, and how the edit prompt is written.
PLACEMENT_RULES = f"""- A product appears in one of three ways; choose the one that looks natural:
  REPLACE an object with a product of the same use and size (a coffee mug becomes a soda can, a plain bag a branded
  tote, a plain shirt a branded shirt or hoodie); PLACE it at an empty spot (a can on a table, a tote over a chair's
  back); DISPLAY it on a flat surface that can show an image (a poster on a blank wall, an ad on a sign, an app on a screen).
- Clothing is a valid spot: a wearable either replaces a garment of the same kind and fit, or is worn over it when it
  is a layer (a jacket, coat, cardigan or scarf over an outfit). Never put a non-wearable on a person's body, and
  never change anyone's face, skin, hair, body, pose or performance.
- It must be plausible where it lands (right size, right use, held or worn the way the original was) and suit the
  scene's place, time and mood (no beer at breakfast, nothing festive in a sombre moment).
- {VISIBILITY_RULE}
- {INTERACTION_RULE}"""

PROMPT_STYLE = """one sentence that names the edit, the product as it looks, exactly where it goes so it is clearly visible, and
  what must stay identical, e.g.
  "Replace the white coffee mug in her hand with a green lemon-lime soda can, label facing the camera; keep her grip, the lighting and reflections identical."
  "Hang a floral canvas tote over the back of the empty chair, front facing the camera; keep the people and lighting identical."
  "Replace his plain green sweatshirt with a navy branded crewneck in the same fit; keep his face, body, pose and the lighting identical."
  "Hang a framed beach travel poster on the blank wall above the table; keep the people, lighting and camera move identical.\"
Name the real product from the catalog in place of these generic ones."""

MATCH_PROMPT = """You place products into the scenes of one film episode, one version per audience. Pick products for every
matchable box (surface) for every audience.

AUDIENCES (id: name (kind)):
{audiences}

SCENES (one per shot; dialogue cues are lines heard in the audio):
{scenes}

BOXES (surfaces found in the frames):
{boxes}

CATALOG (per audience; a product may be used only for an audience it is listed under; id | brand | product | category | fits surfaces | scene affinity):
{catalog}

RULES:
- For every box NOT in a skipped scene, and every audience {regions}: return one row (regionId = the audience id) with
  up to 3 products from that audience's catalog, best first, each with a one-line why (max 12 words). Add a second and
  third choice whenever they would also look natural there, so the producer has alternatives. Use only ids listed for
  that audience. An empty list is right when nothing listed would look natural there.
- Boxes in skipped scenes get NO row.
""" + PLACEMENT_RULES + """
- Brand exclusions: never suggest a brand whose exclusion words describe the scene: {exclusions}
- Never put two competing brands of the same category in one scene: within one scene and audience, the TOP picks of
  different boxes must not be different brands of the same category.
- defaultPrompt: for the top pick only, """ + PROMPT_STYLE + """
- boxNotes: one line per matchable box on why the surface suits a product."""


@dataclass
class GenRequest:
    """One `generate_content` call, built but not sent (so --dry-run can write it out)."""

    stage: str
    model: str
    contents: list
    config: object
    prompt: str
    schema: object
    parts: list[dict] = field(default_factory=list)  # [{kind, mime, bytes, uri?, video_metadata?}]
    media_tokens: int = 0  # budgeting estimate for the non-text parts


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / 4)


class GeminiLLM(LLM):
    name = "gemini"

    def __init__(self, model: str = "gemini-3.8-flash", client=None, project: Optional[str] = None, location: Optional[str] = None,
                 proxy_uri: Optional[str] = None):
        self.model = model
        s = vertex_settings()
        self.project, self.location = project or s["project"], location or s["location"]
        self.proxy_uri = proxy_uri or os.environ.get("CAMEO_PROXY_URI")  # gs:// copy of the proxy when it is over 20 MB
        self.client = client if client is not None else make_vertex_client(self.project, self.location)
        self._lock = threading.Lock()
        self._retried_location = False
        self.usage: list[dict] = []
        self.match_issues: list[str] = []

    # ---------- helpers

    @staticmethod
    def _types():
        from google.genai import types

        return types

    def _json_config(self, schema, **kw):
        t = self._types()
        return t.GenerateContentConfig(response_mime_type="application/json", response_schema=schema, **kw)

    def _video_part(self, proxy: Path) -> tuple[object, dict]:
        t = self._types()
        size = proxy.stat().st_size
        meta = t.VideoMetadata(fps=1)
        if size <= INLINE_MAX_BYTES:
            part = t.Part(inline_data=t.Blob(data=proxy.read_bytes(), mime_type="video/mp4"), video_metadata=meta)
            return part, {"kind": "video", "mime": "video/mp4", "bytes": size, "inline": True, "video_metadata": {"fps": 1}}
        uri = self.proxy_uri or ""
        if not uri.startswith("gs://"):
            raise RuntimeError(
                f"{proxy} is {size / 1e6:.1f} MB, over the {INLINE_MAX_BYTES // (1024 * 1024)} MB inline limit. Upload it "
                f"(gcloud storage cp {proxy} gs://<bucket>/...) and set CAMEO_PROXY_URI=gs://<bucket>/... ; the Files API is not used on Vertex."
            )
        part = t.Part.from_uri(file_uri=uri, mime_type="video/mp4")
        part.video_metadata = meta
        return part, {"kind": "video", "mime": "video/mp4", "bytes": size, "inline": False, "uri": uri, "video_metadata": {"fps": 1}}

    def _record(self, stage: str, resp) -> None:
        u = getattr(resp, "usage_metadata", None)
        if u is None:
            return
        row = {
            "stage": stage,
            "prompt": u.prompt_token_count or 0,
            "output": u.candidates_token_count or 0,
            "thoughts": u.thoughts_token_count or 0,
            "cached": u.cached_content_token_count or 0,
            "total": u.total_token_count or 0,
        }
        with self._lock:
            self.usage.append(row)

    def _switch_location(self, e: Exception) -> bool:
        """On a model/location error, move the client to us-central1 once. True if the call should be retried."""
        if self.project is None or not is_location_error(e):
            return False
        with self._lock:
            if self.location == FALLBACK_LOCATION:
                return self._retried_location  # another thread already switched; this call used the old client
            print(f"[vertex] {self.model} unavailable in {self.location} ({e!s:.160}); retrying once in {FALLBACK_LOCATION}")
            self._retried_location = True
            self.location = FALLBACK_LOCATION
            self.client = make_vertex_client(self.project, FALLBACK_LOCATION, env={"GOOGLE_GENAI_USE_VERTEXAI": "true"})
            return True

    def _generate(self, req: GenRequest):
        """generate_content, with one retry in us-central1 if the model is not served in the configured location."""
        send = lambda: with_backoff(lambda: self.client.models.generate_content(model=req.model, contents=req.contents, config=req.config))  # noqa: E731
        try:
            resp = send()
        except Exception as e:
            if not self._switch_location(e):
                raise
            resp = send()
        self._record(req.stage, resp)
        return resp

    def _generate_hedged(self, req: GenRequest, after: float = HEDGE_AFTER_S):
        """_generate, sent once more if no answer came within `after` seconds; the first answer wins. The slower call
        finishes in the background (its tokens are counted if it ends before the run's usage is saved)."""
        from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

        ex = ThreadPoolExecutor(max_workers=2)
        try:
            first = ex.submit(self._generate, req)
            done, _ = wait([first], timeout=after)
            if done:
                return first.result()
            second = ex.submit(self._generate, req)
            pending = {first, second}
            while pending:
                done, pending = wait(pending, return_when=FIRST_COMPLETED)
                for f in done:
                    if f.exception() is None:
                        return f.result()
            return first.result()  # both failed: raise the first call's error
        finally:
            ex.shutdown(wait=False)

    # ---------- request builders (pure: no network)

    def stage1_request(self, proxy: Path, shots: list[Shot]) -> GenRequest:
        t = self._types()
        video_part, info = self._video_part(proxy)
        shot_table = "\n".join(f"- {s.shotId}: {s.tIn:.2f}s to {s.tOut:.2f}s" for s in shots)
        prompt = SCENE_PROMPT.format(shots=shot_table)
        # Config-level media_resolution is the generateContent field in the SDK; Part.media_resolution also exists per part.
        config = self._json_config(_GShots, media_resolution=t.MediaResolution.MEDIA_RESOLUTION_LOW)  # about 66 tokens per frame
        duration = max((s.tOut for s in shots), default=0.0)
        return GenRequest("stage1", self.model, [video_part, prompt], config, prompt, _GShots, [info], math.ceil(duration * VIDEO_TOKENS_PER_S_LOW))

    def stage2_request(self, keyframe: Keyframe, image: Path, surfaces: list[Surface], objects: Optional[list[dict]] = None) -> GenRequest:
        from .vision import describe

        t = self._types()
        labels = "; ".join(f'"{s.label}" ({s.kind})' for s in surfaces)
        prompt = LOCALISE_PROMPT.format(labels=labels, objects=describe(objects or []))
        data = image.read_bytes()
        config = self._json_config(_GBOX_LIST)  # thinking level left default: Vertex rejects MINIMAL for this model
        info = {"kind": "image", "mime": "image/jpeg", "bytes": len(data), "inline": True, "keyframe": keyframe.path, "t": keyframe.t}
        return GenRequest(f"stage2:{keyframe.shotId}_{keyframe.pos}", self.model, [t.Part.from_bytes(data=data, mime_type="image/jpeg"), prompt], config, prompt, _GBOX_LIST, [info], IMAGE_TOKENS_ASSUMED)

    # ---------- stage 1

    @staticmethod
    def parse_stage1(text: str, shots: list[Shot]) -> list[SceneUnderstanding]:
        data = _GShots.model_validate_json(text)
        by_id = {s.shotId: s for s in data.shots}
        out = []
        for s in shots:  # ingest's timing stays authoritative; shots the model skipped get an empty understanding
            g = by_id.get(s.shotId)
            if g is None:
                out.append(SceneUnderstanding(shotId=s.shotId, tIn=s.tIn, tOut=s.tOut, scene={"type": "unknown", "mood": "unknown"}))
                continue
            out.append(SceneUnderstanding.model_validate({**g.model_dump(), "tIn": s.tIn, "tOut": s.tOut}))
        return out

    def understand_scenes(self, proxy: Path, shots: list[Shot]) -> list[SceneUnderstanding]:
        return self.parse_stage1(self._generate(self.stage1_request(proxy, shots)).text, shots)

    # ---------- stage 2

    @staticmethod
    def parse_stage2(text: str, keyframe: Keyframe, surfaces: list[Surface]) -> LocalisedFrame:
        from pydantic import TypeAdapter

        kinds = {s.label: s.kind for s in surfaces}
        boxes, masks = [], {}
        for o in TypeAdapter(_GBOX_LIST).validate_json(text):
            if len(o.box_2d) != 4:
                continue
            is_face = o.label.lower().startswith("face")
            kind = "face" if is_face else kinds.get(o.label)
            if kind is None:
                continue
            boxes.append(Box(label=o.label, kind=kind, box=NormBox.from_box_2d(o.box_2d), t=keyframe.t, shotId=keyframe.shotId,
                             occludedByHands=max(0.0, min(1.0, o.occluded)), textPresent=o.hasText, nearFace=(0.0 if o.nearFace else None) if not is_face else None))
            if o.mask and not is_face:
                masks[o.label] = [[p[0] / 1000, p[1] / 1000] for p in o.mask if len(p) == 2]  # polygon [x, y] on 0-1000
        return LocalisedFrame(boxes=boxes, masks=masks)

    def localise(self, keyframe: Keyframe, image: Path, surfaces: list[Surface], objects: Optional[list[dict]] = None) -> LocalisedFrame:
        req = self.stage2_request(keyframe, image, surfaces, objects)
        return self.parse_stage2(self._generate_hedged(req).text, keyframe, surfaces)

    # ---------- stage 3: one call per episode (or per chunk of scenes)

    def match_request(self, scenes: list[SceneUnderstanding], boxes: list[Box], catalog: list[Product], rules: RuleSet, regions: list[str], tag: str = "episode") -> GenRequest:
        t = self._types()
        audiences = getattr(self, "audience_text", None) or "\n".join(f"- {r}" for r in regions)
        from .schemas import is_skipped

        skipped = {s.shotId for s in scenes if is_skipped(s)}
        scene_lines = []
        for s in scenes:
            head = f"- {s.shotId} ({s.tIn:.1f}-{s.tOut:.1f}s) {s.scene.type}; mood: {s.scene.mood}; tags: {', '.join(s.scene.tags)}; people {s.people.count}"
            cues = f"; dialogue: {' / '.join(repr(c) for c in s.dialogueCues)}" if s.dialogueCues else ""
            sens = f"; sensitivity {s.sensitivity.level}" + (f" ({'; '.join(s.sensitivity.reasons)})" if s.sensitivity.reasons else "")
            scene_lines.append(head + cues + sens + ("; SKIPPED (no placements)" if s.shotId in skipped else ""))
        box_lines = []
        for b in boxes:
            if b.kind == "face" or b.shotId in skipped:
                continue
            flags = [f for f, on in (("partly occluded", b.occludedByHands > 0.05), ("has text", b.textPresent)) if on]
            span = "+".join(b.shotIds or [b.shotId])
            box_lines.append(f"- {b.id} | shot {span} | {b.kind} | {b.label}" + (f" | {', '.join(flags)}" if flags else ""))
        cat_lines = []
        for r in regions:
            cat_lines.append(f"[{r}]")
            for p in catalog:
                if p.region == r:
                    cat_lines.append(f"- {p.id} | {p.brand} | {p.name} | {p.category} | {', '.join(p.fits)} | {', '.join(p.affinity)}")
        excl = "; ".join(f"{k}: {', '.join(v)}" for k, v in rules.exclusions.items() if v)
        prompt = MATCH_PROMPT.format(audiences=audiences, scenes="\n".join(scene_lines), boxes="\n".join(box_lines), catalog="\n".join(cat_lines), regions=", ".join(regions), exclusions=excl)
        # Low thinking: measured on a 4-box, 3-audience episode, the same top pick for every box and audience as the default
        # level, in 8-12 s instead of 24-56 s, and no thinking tokens eating the output budget (the default level could
        # truncate the JSON). SDK auto-retry off (attempts=1): the caller owns the one allowed retry.
        cfg = self._json_config(_GMatch, max_output_tokens=MATCH_MAX_OUTPUT, thinking_config=t.ThinkingConfig(thinking_level="LOW"),
                                http_options=t.HttpOptions(retry_options=t.HttpRetryOptions(attempts=1)))
        return GenRequest(f"stage3:{tag}", self.model, [prompt], cfg, prompt, _GMatch)

    @staticmethod
    def parse_match(text: str, scenes: list[SceneUnderstanding], boxes: list[Box], catalog: list[Product], regions: list[str]) -> tuple[list[SceneRerank], list[str]]:
        """Model JSON -> SceneRerank per shot. Raises on schema failure; code-enforced rules return as `issues` (dropped rows)."""
        from .schemas import is_skipped

        g = _GMatch.model_validate_json(text)
        skipped = {s.shotId for s in scenes if is_skipped(s)}
        by_box = {b.id: b for b in boxes}
        prod = {(p.id, p.region): p for p in catalog}
        words = {s.shotId: " ".join([s.scene.mood, *s.scene.tags, *s.sensitivity.reasons]).lower() for s in scenes}
        issues: list[str] = []
        per_shot: dict[str, list[Suggestion]] = {}
        seen = set()
        for row in g.matches:
            b = by_box.get(row.boxId)
            if b is None:
                issues.append(f"unknown box {row.boxId}")
                continue
            if b.shotId in skipped or b.blocked:
                issues.append(f"{row.boxId}: skipped box got a row (dropped)")
                continue
            if row.regionId not in regions or (row.boxId, row.regionId) in seen:
                issues.append(f"{row.boxId}/{row.regionId}: unknown or duplicate region (dropped)")
                continue
            seen.add((row.boxId, row.regionId))
            picks = []
            for p in row.suggestions:
                pr = prod.get((p.productId, row.regionId))
                if pr is None:
                    issues.append(f"{row.boxId}/{row.regionId}: {p.productId} not in that audience's catalog (dropped)")
                elif any(x.lower() in words[b.shotId] for x in pr.exclusions):
                    issues.append(f"{row.boxId}/{row.regionId}: {p.productId} excluded by brand rule (dropped)")
                elif p.productId not in {q.productId for q in picks}:
                    picks.append(ProductSuggestion(productId=p.productId, fit=round(0.9 - 0.15 * len(picks), 2), why=p.why))  # rank -> fit (internal only)
            if picks:
                per_shot.setdefault(b.shotId, []).append(Suggestion(boxId=b.id, region=row.regionId, suggestions=picks[:3], defaultPrompt=row.defaultPrompt))
        for b in boxes:
            if b.kind != "face" and not (b.shotId in skipped or b.blocked):
                for r in regions:
                    if (b.id, r) not in seen:
                        issues.append(f"{b.id}/{r}: no row returned")
        # competitor rule check (reported, not rewritten): top picks per scene and region
        for shot, sugs in per_shot.items():
            for r in regions:
                tops = [prod[(s.suggestions[0].productId, r)] for s in sugs if s.region == r]
                for i, a in enumerate(tops):
                    for c in tops[i + 1:]:
                        if a.category == c.category and a.line != c.line:
                            issues.append(f"{shot}/{r}: competing top picks {a.id} and {c.id} ({a.category})")
        notes = {n.boxId: n.note for n in g.boxNotes}
        out = [SceneRerank(shotId=shot, boxNotes={k: v for k, v in notes.items() if by_box.get(k) and by_box[k].shotId == shot}, suggestions=sugs) for shot, sugs in per_shot.items()]
        return out, issues

    def match_episode(self, scenes: list[SceneUnderstanding], boxes: list[Box], catalog: list[Product], rules: RuleSet, regions: list[str], tag: str = "episode") -> list[SceneRerank]:
        req = self.match_request(scenes, boxes, catalog, rules, regions, tag)
        last: Exception | None = None
        for attempt in range(2):  # hard cap: the call, plus one retry on a schema failure (or a transient error)
            try:
                resp = self.client.models.generate_content(model=req.model, contents=req.contents, config=req.config)
            except Exception as e:  # no location fallback here: it would be a third call
                last = e
                print(f"[vertex] stage 3 call {attempt + 1} failed: {e!s:.200}")
                continue
            self._record(req.stage, resp)
            try:
                result, issues = self.parse_match(resp.text or "", scenes, boxes, catalog, regions)
            except Exception as e:
                last = e
                fr = getattr((resp.candidates or [None])[0], "finish_reason", None)
                print(f"[vertex] stage 3 response failed schema validation (finish_reason={fr}): {e!s:.200}")
                continue
            self.match_issues = issues
            return result
        raise RuntimeError(f"stage 3 failed after 2 calls: {last}")

    # ---------- identify (one drawn box)

    def identify_box(self, image: Path, prompt: str, ctx: dict) -> dict:
        t = self._types()
        schema = ctx["schema"]
        contents = [t.Part.from_bytes(data=image.read_bytes(), mime_type="image/jpeg"), prompt]
        # ctx["thinking"]: a short, well-specified answer (an edit prompt) needs little reasoning; LOW is about 1.5 s faster.
        extra = {"thinking_config": t.ThinkingConfig(thinking_level=ctx["thinking"])} if ctx.get("thinking") else {}
        resp = self._generate(GenRequest(stage="identify", model=self.model, contents=contents, config=self._json_config(schema, **extra), prompt=prompt, schema=schema))
        return json.loads(resp.text)

    # ---------- usage

    def usage_summary(self) -> dict:
        tot = {k: sum(r[k] for r in self.usage) for k in ("prompt", "output", "thoughts", "cached", "total")}
        fresh_in = tot["prompt"] - tot["cached"]
        cost = (fresh_in * PRICE_PER_M["input"] + tot["cached"] * PRICE_PER_M["cached"] + (tot["output"] + tot["thoughts"]) * PRICE_PER_M["output"]) / 1e6
        return {"calls": len(self.usage), **tot, "costUSD": round(cost, 5), "prices": PRICE_PER_M, "perCall": self.usage}


# ================================================================ Dry run


class DryRunGeminiLLM(GeminiLLM):
    """Builds every Vertex request and writes it to <out>/requests/ without calling the API.

    Results come from MockLLM so later stages have something to build requests from (stage-2 requests therefore
    use the mock's stage-1 surfaces; the live run uses the model's own)."""

    name = "dryrun"

    def __init__(self, requests_dir: Path, **kw):
        super().__init__(client=False, **kw)
        self.client = None
        self.requests_dir = Path(requests_dir)
        self.requests_dir.mkdir(parents=True, exist_ok=True)
        self._mock = MockLLM()
        self.index: list[dict] = []

    def _write(self, req: GenRequest) -> dict:
        from google.genai import _transformers

        sdk_schema = _transformers.t_schema(None, req.schema)  # what the SDK sends as responseSchema
        schema_json = json.dumps(sdk_schema.model_dump(exclude_none=True, mode="json"), ensure_ascii=False)
        cfg = req.config.model_dump(exclude_none=True, mode="json", exclude={"response_schema"})
        text_tokens = estimate_tokens(req.prompt) + estimate_tokens(schema_json)
        doc = {
            "stage": req.stage,
            "model": req.model,
            "location": self.location,
            "project": self.project,
            "prompt": req.prompt,
            "parts": req.parts,
            "config": cfg,
            "responseSchema": json.loads(schema_json),
            "tokenEstimate": {"promptText": estimate_tokens(req.prompt), "schema": estimate_tokens(schema_json), "media": req.media_tokens, "total": text_tokens + req.media_tokens},
        }
        name = req.stage.replace(":", "_")
        (self.requests_dir / f"{name}.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False))
        (self.requests_dir / f"{name}.prompt.txt").write_text(req.prompt)
        row = {"file": f"{name}.json", "stage": req.stage, "bytes": sum(p["bytes"] for p in req.parts), **doc["tokenEstimate"]}
        with self._lock:
            self.index.append(row)
        return row

    def understand_scenes(self, proxy: Path, shots: list[Shot]) -> list[SceneUnderstanding]:
        self._write(self.stage1_request(proxy, shots))
        return self._mock.understand_scenes(proxy, shots)

    def localise(self, keyframe: Keyframe, image: Path, surfaces: list[Surface], objects: Optional[list[dict]] = None) -> LocalisedFrame:
        self._write(self.stage2_request(keyframe, image, surfaces, objects))
        return self._mock.localise(keyframe, image, surfaces)

    def match_episode(self, scenes: list[SceneUnderstanding], boxes: list[Box], catalog: list[Product], rules: RuleSet, regions: list[str], tag: str = "episode") -> list[SceneRerank]:
        self._write(self.match_request(scenes, boxes, catalog, rules, regions, tag))
        return self._mock.match_episode(scenes, boxes, catalog, rules, regions)


def get_llm(name: str) -> LLM:
    if name == "mock":
        return MockLLM()
    if name == "gemini":
        return GeminiLLM(model=os.environ.get("CAMEO_MODEL", "gemini-3.8-flash"))
    raise ValueError(f"unknown llm {name!r}")


__all__ = ["LLM", "MockLLM", "GeminiLLM", "DryRunGeminiLLM", "GenRequest", "get_llm", "make_vertex_client", "vertex_settings", "is_location_error", "default_prompt"]
