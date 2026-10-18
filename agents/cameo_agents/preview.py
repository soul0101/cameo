"""Preview stills: one scene version's keyframe edited by Nano Banana 2.1 so the chosen products sit in the shot.

    POST /episodes/{id}/previews  {shotId, audienceId, prompt, items: [{n, label, kind?, edit?, box, product, image?}]}

The frame is pulled from the source video at the shot's middle keyframe (long side <= 1536 px), sent with the edit
instruction (and any product images as references) to `gemini-nano-banana-2.1` on Vertex AI (served from `global`
only), at 1K and the frame's own aspect ratio. The answer is scaled back to the frame's exact size, cached by
(frame, instruction, references, model), and never generated twice.

The instruction follows Google's editing guidance for Nano Banana (ai.google.dev image-generation docs, the Vertex
best-practices page and the Google Cloud prompting guide): open with an imperative edit verb, name what changes and
what stays exactly the same, mask by description (each spot is named and located in words; the model has no box
input), say how each product should blend in (light direction, colour temperature, shadows, perspective, scale,
grain), refer to reference images by position, quote any label text exactly, and say not to crop, zoom or restyle.

Backends (CAMEO_IMAGE): `gemini` (default), `mock` (tests: returns the frame unchanged), `off` (503).
Price (Gemini API list price for 2.1, used as the estimate; Vertex bills the same tokens): $1.50 per 1M input tokens,
$30 per 1M image output tokens; a 1K image is 1,120 output tokens, about $0.034.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field

from .schemas import INTERACTION_RULE, VISIBILITY_RULE

IMAGE_MODEL = os.environ.get("CAMEO_IMAGE_MODEL", "gemini-nano-banana-2.1")
IMAGE_LOCATION = "global"  # Nano Banana 2.1 is served from the global endpoint only
IMAGE_SIZE = "1K"
INPUT_PER_TOKEN = 1.50 / 1_000_000
IMAGE_OUT_PER_TOKEN = 30.0 / 1_000_000
IMAGE_OUT_TOKENS = 1120  # one 1K image
IMAGE_IN_TOKENS = 1120  # one input image
PRICE_PER_IMAGE = round(IMAGE_OUT_TOKENS * IMAGE_OUT_PER_TOKEN + (IMAGE_IN_TOKENS + 900) * INPUT_PER_TOKEN, 4)
FRAME_LONG_SIDE = 1536
MAX_REFS = 4
RATIOS = {"1:1": 1, "3:2": 3 / 2, "2:3": 2 / 3, "3:4": 3 / 4, "4:3": 4 / 3, "4:5": 4 / 5, "5:4": 5 / 4, "9:16": 9 / 16, "16:9": 16 / 9, "21:9": 21 / 9, "9:21": 9 / 21}


class PreviewProduct(BaseModel):
    brand: str = Field(max_length=120)
    name: str = Field(max_length=300)
    category: str = Field("", max_length=120)
    description: Optional[str] = Field(None, max_length=1000)


class PreviewBox(BaseModel):
    x: float
    y: float
    w: float
    h: float


class PreviewItem(BaseModel):
    n: int
    boxId: Optional[str] = Field(None, max_length=80)  # the scene box (web id), kept so a sample can be rebuilt
    productId: Optional[str] = Field(None, max_length=128)
    label: str = Field(max_length=200)
    kind: Optional[str] = Field(None, max_length=40)
    edit: Optional[str] = Field(None, max_length=20)
    box: PreviewBox
    product: PreviewProduct
    image: Optional[str] = Field(None, max_length=8_000_000)  # data URL of the product image (reference)


class PreviewRequest(BaseModel):
    shotId: str = Field(pattern=r"^[A-Za-z0-9_-]+$", max_length=40)
    audienceId: str = Field(max_length=64)
    audienceName: Optional[str] = Field(None, max_length=120)
    prompt: str = Field(min_length=1, max_length=4000)
    items: list[PreviewItem] = Field(min_length=1, max_length=8)


# ---------------------------------------------------------------- the instruction

_OBJECT_WORDS = re.compile(r"\b(cup|mug|glass|bottle|can|bag|tote|box|pack|packet|plate|bowl|laptop|phone|tablet|book|jar|carton|bowl|tray|lunchbox|thermos|kettle|cap|hat)s?\b", re.I)


def edit_kind(item: PreviewItem) -> str:
    """replace (swap an object), garment (swap clothing), place (set onto a surface) or display (show an image on a flat surface)."""
    kind = (item.kind or "").lower()
    if kind == "apparel":
        return "garment"
    if item.edit == "display" or kind in ("wall", "sign", "screen"):
        return "display"
    if item.edit == "replace" or kind == "hand" or _OBJECT_WORDS.search(item.label):
        return "replace"
    return "place"


def where(b: PreviewBox) -> str:
    """The spot's position in words (the model takes no box input): 'in the lower left of the frame'."""
    cx, cy = b.x + b.w / 2, b.y + b.h / 2
    v = "upper" if cy < 0.36 else "lower" if cy > 0.64 else "middle"
    h = "left" if cx < 0.36 else "right" if cx > 0.64 else "centre"
    spot = "centre" if (v, h) == ("middle", "centre") else f"{v} {h}" if v != "middle" else f"middle {h}" if h != "centre" else "centre"
    size = "a large area" if b.w * b.h > 0.12 else "a small area" if b.w * b.h < 0.02 else "a medium area"
    return f"in the {spot} of the frame ({size})"


def product_words(p: PreviewProduct) -> str:
    look = (p.description or "").strip().rstrip(".")
    name = p.name if p.name.lower().startswith(p.brand.lower()) else f"{p.brand} {p.name}"
    return f"{name} ({look})" if look and look.lower() != name.lower() else name


def change_line(item: PreviewItem, ref: Optional[int]) -> str:
    what = product_words(item.product)
    looks = f", matching the product in image {ref} exactly (shape, colours, label)" if ref else ""
    spot = f"the {item.label.strip().rstrip('.')} {where(item.box)}"
    k = edit_kind(item)
    if k == "garment":
        return (f"Dress the wearer of {spot} in {what}{looks}: the same kind of garment replaces it in the same fit, and a layer "
                f"(a jacket, coat, cardigan or scarf) is worn over it, open or closed as the look suits. Fitted to their pose and "
                f"body with natural folds and the scene's lighting; their face, skin, hair, hands and pose stay completely unchanged.")
    if k == "display":
        kind, label = (item.kind or "").lower(), item.label.lower()
        if kind == "screen" or "screen" in label or "monitor" in label:
            return (f"On {spot}, show {what}{looks} as the screen's content (its app, site or ad), following the screen's "
                    f"perspective, brightness and glare, as a real screen would look on camera.")
        if kind == "wall" or "wall" in label:
            return (f"Hang a framed poster advertising {what}{looks} on {spot}, at a size a real poster would be there, flat "
                    f"against the wall in its perspective, lit like the wall around it, with a faint shadow under the frame.")
        return (f"On {spot}, show an ad for {what}{looks}: warp it to the surface's perspective and match its brightness, "
                f"glare and texture, as if it had been there when the scene was filmed.")
    if k == "replace":
        return (f"Replace only {spot} with {what}{looks}, at the same real-world size and position, held or resting exactly "
                f"as the original was, with matching contact shadows and reflections.")
    return (f"Place {what}{looks} at {spot}, at its real-world size next to the nearby objects, resting or hanging the way such "
            f"a product naturally would there, with a soft contact shadow and any reflection the surface would show.")


def instruction(req: PreviewRequest, refs: list[int]) -> str:
    """The full edit instruction sent with the frame (image 1) and product references (images 2+)."""
    lines = [
        "Edit image 1, a still frame from a finished film, to add product placements. Change only the spots listed below "
        "and keep everything else in the image exactly the same.",
        "",
        "Changes:",
    ]
    ref_of = {it.n: r for it, r in zip([i for i in req.items if i.image], refs)}
    for i, item in enumerate(req.items, start=1):
        lines.append(f"{i}. {change_line(item, ref_of.get(item.n))}")
    brands = sorted({it.product.brand for it in req.items if it.product.brand})
    lines += [
        "",
        f"The producer's notes for this version (follow them where they add detail): {req.prompt.strip()}",
        "",
        "How every change must look:",
        "- Photorealistic and native to the shot: match the scene's light direction, colour temperature, contrast, depth of field, film grain and any motion blur.",
        "- Correct perspective and real-world scale relative to the objects around it; nothing floats, nothing is pasted flat.",
        f"- Clearly visible: {VISIBILITY_RULE}",
        f"- Natural use: {INTERACTION_RULE}",
        ("- Brand text appears only on the products, spelled exactly " + ", ".join(f'"{b}"' for b in brands) + ", clean and legible; add no other text, logos or watermarks.") if brands else "- Add no text, logos or watermarks.",
        "",
        "Keep exactly the same: every person's face, identity, expression, skin, hair, hands and pose (only what they hold or eat "
        "changes, as the swap requires); all other objects; "
        "the background; the framing, crop, camera angle and aspect ratio. Do not zoom, crop, restyle, recolour or re-light the image.",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------- frame and output


def _run(cmd: list[str]) -> None:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {p.stderr.strip()[-400:]}")


def frame_for(out: Path, shot_id: str) -> tuple[Path, int, int]:
    """The shot's middle keyframe at up to FRAME_LONG_SIDE px from the source video (cached), and its size."""
    ing = json.loads((out / "ingest.json").read_text())
    shot = next((s for s in ing["shots"] if s["shotId"] == shot_id), None)
    if shot is None:
        raise FileNotFoundError(f"no shot {shot_id}")
    kf = next((k for k in shot.get("keyframes", []) if k["pos"] == "mid"), None)
    t = kf["t"] if kf else (shot["tIn"] + shot["tOut"]) / 2
    w, h = int(ing["width"]), int(ing["height"])
    scale = min(1.0, FRAME_LONG_SIDE / max(w, h))
    fw, fh = int(round(w * scale / 2) * 2), int(round(h * scale / 2) * 2)
    dest = out / "frames" / f"{shot_id}_mid.jpg"
    with key_lock(str(dest)):  # one ffmpeg per frame; a parallel request waits for the finished file
        _extract_frame(out, ing, shot_id, t, fw, fh, dest)
    return dest, fw, fh


def _extract_frame(out: Path, ing: dict, shot_id: str, t: float, fw: int, fh: int, dest: Path) -> None:
    if not dest.is_file():
        # the source at full quality; else the 720 px keyframe (a deployed sample ships frames/ already); else the proxy
        src = Path(ing.get("video") or "")
        if not src.is_file():
            src = next(out.glob("source.*"), None) or (out / "keyframes" / f"{shot_id}_mid.jpg" if (out / "keyframes" / f"{shot_id}_mid.jpg").is_file() else out / "proxy_360p.mp4")
        seek = [] if src.suffix == ".jpg" else ["-ss", f"{t:.3f}"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f"{shot_id}_mid.part.jpg")
        _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *seek, "-i", str(src), "-frames:v", "1", "-vf", f"scale={fw}:{fh}", "-q:v", "2", str(tmp)])
        tmp.replace(dest)


def nearest_ratio(w: int, h: int) -> str:
    r = w / h
    return min(RATIOS, key=lambda k: abs(RATIOS[k] - r))


def fit_to(png: bytes, w: int, h: int, dest: Path) -> None:
    """Scale (cover) and centre-crop the model's image to the frame's exact size, so it lines up with the original."""
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        f.write(png)
        tmp = f.name
    try:
        _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", tmp, "-vf", f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}", "-frames:v", "1", str(dest)])
    finally:
        os.unlink(tmp)


def _data_url(s: str) -> tuple[bytes, str]:
    """A product reference image: a data URL from the browser (uploads, and starter photos the web app ships)."""
    m = re.match(r"^data:(image/(?:png|jpeg|jpg|webp));base64,(.+)$", s, re.S)
    if not m:
        raise ValueError("product image must be a PNG, JPEG or WebP data URL")
    return base64.b64decode(m.group(2)), m.group(1).replace("jpg", "jpeg")


# ---------------------------------------------------------------- backends


class ImageError(RuntimeError):
    pass


from .models import with_backoff  # noqa: E402,F401  (shared 429 retry; render.py imports it from here)


class GeminiImage:
    name = "gemini"

    def __init__(self):
        from .models import make_vertex_client

        self.client = make_vertex_client(location=IMAGE_LOCATION)

    def edit(self, frame: bytes, refs: list[tuple[bytes, str]], text: str, ratio: str) -> tuple[bytes, dict]:
        from google.genai import types

        parts = [types.Part.from_bytes(data=frame, mime_type="image/jpeg")] + [types.Part.from_bytes(data=b, mime_type=m) for b, m in refs] + [text]
        config = types.GenerateContentConfig(response_modalities=["IMAGE"], image_config=types.ImageConfig(aspect_ratio=ratio, image_size=IMAGE_SIZE))
        last = ""
        for attempt in range(2):  # a text-only answer (no image) gets one retry
            resp = with_backoff(lambda: self.client.models.generate_content(model=IMAGE_MODEL, contents=parts, config=config))
            for c in resp.candidates or []:
                for p in (c.content.parts if c.content else None) or []:
                    if p.inline_data and p.inline_data.data:
                        u = resp.usage_metadata
                        return p.inline_data.data, {"prompt": (u.prompt_token_count or 0) if u else 0, "output": (u.candidates_token_count or 0) if u else 0, "attempts": attempt + 1}
                    if p.text:
                        last = p.text
            reason = (resp.candidates[0].finish_reason if resp.candidates else None) or getattr(resp.prompt_feedback, "block_reason", None)
            last = last or f"no image returned ({reason})"
        raise ImageError(last[:300])


class MockImage:
    name = "mock"

    def edit(self, frame: bytes, refs, text: str, ratio: str) -> tuple[bytes, dict]:
        return frame, {"prompt": 0, "output": 0, "attempts": 1}


_BACKEND = None


def get_image_backend():
    global _BACKEND
    kind = os.environ.get("CAMEO_IMAGE", "gemini")
    if kind == "off":
        return None
    if _BACKEND is None or _BACKEND.name != kind:
        _BACKEND = MockImage() if kind == "mock" else GeminiImage()
    return _BACKEND


# ---------------------------------------------------------------- generate (cached)


def _keep_ref(out: Path, image: Optional[str]) -> Optional[str]:
    """Keep a product photo that came with a request (out/<ep>/refs/<hash>), so a sample can show the product later."""
    if not image:
        return None
    data, mime = _data_url(image)
    name = f"{hashlib.sha256(data).hexdigest()[:20]}.{'png' if mime.endswith('png') else 'webp' if mime.endswith('webp') else 'jpg'}"
    p = out / "refs" / name
    if not p.is_file():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    return f"/episodes/{out.name}/refs/{name}"


_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def key_lock(key: str) -> threading.Lock:
    """One lock per cache key: identical requests at the same time make one model call, the others wait for it."""
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.Lock())


def generate(out: Path, req: PreviewRequest, backend) -> dict:
    """Edit the shot's frame for one scene version; cached by (frame, instruction, references, model)."""
    frame_path, w, h = frame_for(out, req.shotId)
    frame = frame_path.read_bytes()
    refs = [_data_url(i.image) for i in req.items if i.image][:MAX_REFS]
    text = instruction(req, list(range(2, 2 + len(refs))))
    key = hashlib.sha256(json.dumps([hashlib.sha256(frame).hexdigest(), text, [hashlib.sha256(b).hexdigest() for b, _ in refs], IMAGE_MODEL, backend.name]).encode()).hexdigest()[:20]
    with key_lock(f"{out.name}/preview/{key}"):
        return _generate(out, req, backend, frame, refs, text, key, w, h)


def _generate(out: Path, req: PreviewRequest, backend, frame: bytes, refs, text: str, key: str, w: int, h: int) -> dict:
    d = out / "previews"
    png, meta_p = d / f"{key}.png", d / f"{key}.json"
    if png.is_file() and meta_p.is_file():
        return {**json.loads(meta_p.read_text()), "cached": True}
    t0 = time.monotonic()
    data, usage = backend.edit(frame, refs, text, nearest_ratio(w, h))
    d.mkdir(parents=True, exist_ok=True)
    fit_to(data, w, h, png)
    cost = round(usage["prompt"] * INPUT_PER_TOKEN + usage["output"] * IMAGE_OUT_PER_TOKEN, 4) if backend.name == "gemini" else 0.0
    meta = {"id": key, "shotId": req.shotId, "audienceId": req.audienceId, "model": IMAGE_MODEL if backend.name == "gemini" else backend.name,
            "seconds": round(time.monotonic() - t0, 1), "cost": cost, "usage": usage, "width": w, "height": h, "instruction": text,
            "items": [{**i.model_dump(exclude={"image"}), "imageUrl": _keep_ref(out, i.image)} for i in req.items]}
    meta_p.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    with (d / "usage.jsonl").open("a") as f:
        f.write(json.dumps({"id": key, "t": time.time(), "model": meta["model"], "cost": cost, **usage}) + "\n")
    return {**meta, "cached": False}
