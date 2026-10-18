"""Cloud Vision object localization on the ingest keyframes (runs after ingest, before stage 1).

    python -m cameo_agents.vision out/<episode> [--vision cloud|mock]

Each keyframe gets one OBJECT_LOCALIZATION request; the answer is cached in out/<ep>/cache/vision/<keyframe>.json as
{keyframe, objects: [{name, score, box: {x, y, w, h}}]} (0..1 fractions of the frame). A cached keyframe is never sent
again. The objects are context for the stage-2 localise prompt and the identify prompt, and detected.json lists the mid
keyframe's objects per shot as `visionObjects`.

Backends (CAMEO_VISION): `cloud` (google-cloud-vision, ADC credentials; default), `mock` (tests: a fixed object per
frame, no network), `off` (no objects).
Price: $1.50 per 1,000 images (the first 1,000 a month are free; the estimate ignores the free tier).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Optional

from .schemas import IngestResult, Keyframe

PRICE_PER_IMAGE = 1.50 / 1000
WORKERS = 8
MAX_OBJECTS = 20


class Vision(ABC):
    name = "vision"

    @abstractmethod
    def localize(self, image: Path) -> list[dict]:
        """[{name, score, box: {x, y, w, h}}] for one image."""


class CloudVision(Vision):
    name = "cloud"

    def __init__(self, client=None):
        if client is None:
            from google.cloud import vision

            client = vision.ImageAnnotatorClient()
        self.client = client

    def localize(self, image: Path) -> list[dict]:
        from google.cloud import vision

        resp = self.client.object_localization(image=vision.Image(content=image.read_bytes()))
        if resp.error.message:
            raise RuntimeError(f"Cloud Vision: {resp.error.message}")
        return parse_annotations(resp.localized_object_annotations)


class MockVision(Vision):
    """Tests only: one 'Cup' in the middle of every frame. Never the API default."""

    name = "mock"

    def localize(self, image: Path) -> list[dict]:
        return [{"name": "Cup", "score": 0.9, "box": {"x": 0.4, "y": 0.5, "w": 0.1, "h": 0.15}}]


class NoVision(Vision):
    name = "off"

    def localize(self, image: Path) -> list[dict]:
        return []


def get_vision(name: Optional[str] = None) -> Vision:
    name = (name or os.environ.get("CAMEO_VISION") or "cloud").lower()
    if name == "cloud":
        return CloudVision()
    if name == "mock":
        return MockVision()
    if name == "off":
        return NoVision()
    raise ValueError(f"unknown vision backend {name!r}")


def _clamp(v: float) -> float:
    return max(0.0, min(1.0, float(v)))


def parse_annotations(annotations) -> list[dict]:
    out = []
    for a in annotations:
        vs = list(a.bounding_poly.normalized_vertices)
        if not vs:
            continue
        xs, ys = [_clamp(v.x) for v in vs], [_clamp(v.y) for v in vs]
        x, y = min(xs), min(ys)
        out.append({"name": a.name, "score": round(float(a.score), 3), "box": {"x": round(x, 4), "y": round(y, 4), "w": round(max(xs) - x, 4), "h": round(max(ys) - y, 4)}})
    out.sort(key=lambda o: -o["score"])
    return out[:MAX_OBJECTS]


def cache_dir(out: Path) -> Path:
    return out / "cache" / "vision"


def keyframes(ing: IngestResult) -> list[Keyframe]:
    return [k for s in ing.shots for k in s.keyframes]


def uncached(ing: IngestResult, out: Path) -> list[Keyframe]:
    return [k for k in keyframes(ing) if not (cache_dir(out) / f"{Path(k.path).stem}.json").is_file()]


def estimate(ing: IngestResult, out: Path) -> tuple[int, float]:
    """(images still to send, USD) for the confirmation estimate."""
    n = len(uncached(ing, out))
    return n, round(n * PRICE_PER_IMAGE, 4)


def run_vision(ing: IngestResult, out: Path, vision: Vision, on_progress: Optional[Callable[[str, float], None]] = None, workers: int = WORKERS) -> dict:
    """Localize objects on every keyframe that has no cache file yet. Returns {keyframes, objects, calls, cost}."""
    todo = uncached(ing, out)
    d = cache_dir(out)
    d.mkdir(parents=True, exist_ok=True)
    done = [0]

    def one(k: Keyframe) -> None:
        objs = vision.localize(out / k.path)
        stem = Path(k.path).stem
        (d / f"{stem}.json").write_text(json.dumps({"keyframe": stem, "backend": vision.name, "objects": objs}, indent=2))
        done[0] += 1
        if on_progress:
            on_progress(f"{stem} · {len(objs)} objects", done[0] / max(len(todo), 1))

    if todo and not isinstance(vision, NoVision):
        with ThreadPoolExecutor(max_workers=workers) as ex:
            list(ex.map(one, todo))
    calls = len(todo) if not isinstance(vision, NoVision) else 0
    return {**counts(ing, out), "calls": calls, "cost": round(calls * PRICE_PER_IMAGE if vision.name == "cloud" else 0.0, 4)}


def load_objects(out: Path, stem: str) -> list[dict]:
    p = cache_dir(out) / f"{stem}.json"
    if not p.is_file():
        return []
    try:
        return json.loads(p.read_text()).get("objects", [])
    except ValueError:
        return []


def by_keyframe(out: Path) -> dict[str, list[dict]]:
    d = cache_dir(out)
    return {p.stem: load_objects(out, p.stem) for p in sorted(d.glob("*.json"))} if d.is_dir() else {}


def counts(ing: IngestResult, out: Path) -> dict:
    """Event counts: keyframes with a vision result and total objects found."""
    stems = [Path(k.path).stem for k in keyframes(ing)]
    have = [s for s in stems if (cache_dir(out) / f"{s}.json").is_file()]
    return {"visionFrames": len(have), "objects": sum(len(load_objects(out, s)) for s in have)}


def shot_objects(out: Path, shot_id: str) -> list[dict]:
    """The objects on the shot's mid keyframe (the frame the Scenes page shows); falls back to start/end."""
    for pos in ("mid", "start", "end"):
        objs = load_objects(out, f"{shot_id}_{pos}")
        if objs:
            return objs
    return []


def describe(objs: list[dict]) -> str:
    """Prompt text: 'Cup 0.91 at [x 0.40 y 0.50 w 0.10 h 0.15]; ...'."""
    return "; ".join(f"{o['name']} {o['score']:.2f} at [x {o['box']['x']:.2f} y {o['box']['y']:.2f} w {o['box']['w']:.2f} h {o['box']['h']:.2f}]" for o in objs) or "none found"


def near_box(objs: list[dict], box: dict, margin: float = 0.05) -> list[dict]:
    """Objects whose box overlaps the drawn box (grown by `margin`), largest overlap first."""
    bx0, by0, bx1, by1 = box["x"] - margin, box["y"] - margin, box["x"] + box["w"] + margin, box["y"] + box["h"] + margin
    scored = []
    for o in objs:
        b = o["box"]
        iw = min(bx1, b["x"] + b["w"]) - max(bx0, b["x"])
        ih = min(by1, b["y"] + b["h"]) - max(by0, b["y"])
        if iw > 0 and ih > 0:
            scored.append((iw * ih, o))
    return [o for _, o in sorted(scored, key=lambda x: -x[0])]


SNAP_IOU = 0.5


def _iou(a: dict, b: dict) -> float:
    iw = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
    ih = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
    inter = max(0.0, iw) * max(0.0, ih)
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


def snap_box(objs: list[dict], box: dict, min_iou: float = SNAP_IOU) -> tuple[dict, Optional[str]]:
    """A box drawn by hand, tightened to the Cloud Vision object it mostly covers (IoU >= min_iou), else unchanged.

    Vision outlines whole objects tightly (a shirt, a mug, a laptop), which is what a replace edit needs. Gemini's
    surface boxes (walls, table tops) are not objects, and snapping them lowered IoU against hand labels, so only drawn
    boxes snap."""
    best = max(objs, key=lambda o: _iou(o["box"], box), default=None)
    if best is None or _iou(best["box"], box) < min_iou:
        return box, None
    return {k: round(float(best["box"][k]), 4) for k in ("x", "y", "w", "h")}, best["name"]


def main(argv: list[str] | None = None) -> int:
    from .ingest import load_ingest

    ap = argparse.ArgumentParser(prog="python -m cameo_agents.vision", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out_dir")
    ap.add_argument("--vision", choices=["cloud", "mock", "off"], default=None)
    a = ap.parse_args(argv)
    out = Path(a.out_dir).resolve()
    ing = load_ingest(out)
    n, cost = estimate(ing, out)
    print(f"{n} keyframes to send (~${cost:.4f})")
    r = run_vision(ing, out, get_vision(a.vision), on_progress=lambda m, f: print(f"  {m}"))
    print(f"vision: {r['visionFrames']} keyframes · {r['objects']} objects · {r['calls']} calls · ${r['cost']:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
