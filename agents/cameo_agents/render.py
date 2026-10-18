"""Render a scene version with Gemini Omni: the shot's own video, edited so its products match the approved still.

    POST /episodes/{id}/renders  {shotId, audienceId, stillId, items, resolution: "360p"}

One Omni call per shot (uploads are capped at 10 s, Omni's input limit, so a shot always fits). The call gets:
  - the shot itself (cut from the source, 24 fps, no audio),
  - <IMAGE_REF_0>: the approved Nano Banana still of this shot and audience, the ground truth for the products,
  - <IMAGE_REF_1>, when another shot of the same scene (Gemini's `sceneGroup`) was already rendered for this audience:
    its middle frame, so the products stay identical across the cuts of one scene,
  - a short instruction (Google: keep edit prompts simple, say "single continuous shot", end with "Keep everything
    else the same").
Omni re-renders the whole frame but keeps the shot's length, frame count and motion (measured: 192 frames in, 192
out). The result is fitted to the shot's exact duration, gets the original audio back (Omni writes its own), and is
checked by Gemini against the still: products match, no new cuts, people unchanged. Everything is cached by inputs.

Backends (CAMEO_VIDEO): `gemini` (default), `mock` (tests: the clip comes back unchanged), `off`.
Output is fixed at 360p to bound cost. Price (list): video output $17.50 per 1M tokens, about 1,931 tokens a second at
360p (measured); input $1.50 per 1M tokens, about 1,500 tokens a second of 720p input video.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Literal, Optional

from pydantic import BaseModel, Field

from .preview import PreviewBox, PreviewProduct, edit_kind, with_backoff
from .schemas import INTERACTION_RULE, VISIBILITY_RULE

OMNI_MODEL = os.environ.get("CAMEO_OMNI_MODEL", "gemini-omni-1.1-flash-preview")
VERIFY_MODEL = os.environ.get("CAMEO_MODEL", "gemini-3.8-flash")
OUT_TOKENS_PER_S = {"360p": 1931}
IN_TOKENS_PER_S = 1500
PRICE_PER_S = {r: round(t * 17.5e-6 + IN_TOKENS_PER_S * 1.5e-6, 4) for r, t in OUT_TOKENS_PER_S.items()}
MAX_INPUT_S = 10.0
CLIP_SHORT_SIDE = 720

Resolution = Literal["360p"]


class RenderItem(BaseModel):
    boxId: Optional[str] = Field(None, max_length=80)  # the scene box (web id), kept so a sample can be rebuilt
    productId: Optional[str] = Field(None, max_length=128)
    label: str = Field(max_length=200)
    kind: Optional[str] = Field(None, max_length=40)
    edit: Optional[str] = Field(None, max_length=20)
    box: PreviewBox
    product: PreviewProduct


class RenderRequest(BaseModel):
    shotId: str = Field(pattern=r"^[A-Za-z0-9_-]+$", max_length=40)
    audienceId: str = Field(max_length=64)
    stillId: str = Field(pattern=r"^[0-9a-f]{20}$")
    items: list[RenderItem] = Field(min_length=1, max_length=8)
    resolution: Resolution = "360p"
    attempt: int = Field(1, ge=1, le=5)  # "Try again" after a failed check: a new take, not the cached one


# ---------------------------------------------------------------- media helpers


def _run(cmd: list[str]) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {p.stderr.strip()[-400:]}")
    return p.stdout


def _has_audio(path: Path) -> bool:
    return bool(_run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)]).strip())


def _source(out: Path, ing: dict) -> Path:
    src = Path(ing.get("video") or "")
    if src.is_file():
        return src
    return next(out.glob("source.*"), out / "proxy_360p.mp4")


def shot_of(ing: dict, shot_id: str) -> dict:
    shot = next((s for s in ing["shots"] if s["shotId"] == shot_id), None)
    if shot is None:
        raise FileNotFoundError(f"no shot {shot_id}")
    return shot


def clip_for(out: Path, shot_id: str) -> tuple[Path, float]:
    """The shot as Omni's input: cut from the source, at most 10 s, 24 fps, short side 720, no audio (cached)."""
    ing = json.loads((out / "ingest.json").read_text())
    shot = shot_of(ing, shot_id)
    dur = min(MAX_INPUT_S, shot["tOut"] - shot["tIn"])
    dest = out / "clips" / f"{shot_id}.mp4"
    with key_lock(str(dest)):  # one ffmpeg per clip; a parallel render (another audience) waits for the finished file
        if not dest.is_file():
            dest.parent.mkdir(parents=True, exist_ok=True)
            w, h = int(ing["width"]), int(ing["height"])
            scale = f"scale=-2:{CLIP_SHORT_SIDE}" if w >= h else f"scale={CLIP_SHORT_SIDE}:-2"
            _run(["ffmpeg", "-v", "error", "-y", "-ss", f"{shot['tIn']:.3f}", "-i", str(_source(out, ing)), "-t", f"{dur:.3f}",
                  "-vf", f"{scale},fps=24", "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", str(dest.with_name(f"{shot_id}.part.mp4"))])
            dest.with_name(f"{shot_id}.part.mp4").replace(dest)
    return dest, dur


def middle_frame(video: Path) -> bytes:
    dur = float(_run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)]).strip() or 0)
    p = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{dur / 2:.3f}", "-i", str(video), "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "-q:v", "2", "-"],
                       capture_output=True, check=True)
    return p.stdout


def finish(raw: Path, out: Path, shot_id: str, dur: float, dest: Path) -> None:
    """Omni's clip at the shot's exact duration with the shot's original audio (Omni writes its own)."""
    ing = json.loads((out / "ingest.json").read_text())
    shot = shot_of(ing, shot_id)
    src = _source(out, ing)
    audio = _has_audio(src)
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(raw)]
    if audio:
        cmd += ["-ss", f"{shot['tIn']:.3f}", "-t", f"{dur:.3f}", "-i", str(src)]
    cmd += ["-vf", f"tpad=stop_mode=clone:stop_duration=1,trim=duration={dur:.3f},setpts=PTS-STARTPTS", "-map", "0:v:0"]
    if audio:
        cmd += ["-map", "1:a:0", "-c:a", "aac", "-b:a", "128k"]
    tmp = dest.with_name(dest.stem + ".part.mp4")
    cmd += ["-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", f"{dur:.3f}", str(tmp)]
    _run(cmd)
    tmp.replace(dest)


# ---------------------------------------------------------------- the instruction


def change_phrase(item: RenderItem) -> str:
    p = item.product
    name = p.name if p.name.lower().startswith(p.brand.lower()) else f"{p.brand} {p.name}"
    label = item.label.strip().rstrip(".").lower()
    k = edit_kind(item)  # the same four kinds as the still: replace, garment, place, display
    if k == "garment":
        return f"the wearer of the {label} wears the {name} (in its place if it is the same kind of garment, over it if it is a layer)"
    if k == "display":
        return f"the {label} shows the {name} ad"
    if k == "replace":
        return f"the {label} is replaced by the {name}"
    return f"the {name} is placed at the {label}, resting or hanging as it naturally would there"


def instruction(req: RenderRequest, continuity: bool) -> str:
    changes = "; ".join(change_phrase(i) for i in req.items)
    lines = [
        "Single continuous shot, no cuts.",
        f"Edit this video so it matches <IMAGE_REF_0>, an edited frame of this same shot: {changes}.",
        "The products look exactly as in <IMAGE_REF_0> for the whole shot and move only with the camera or with the hand that holds them.",
        VISIBILITY_RULE,
        INTERACTION_RULE,
    ]
    if continuity:
        lines.append("The same products already appear in another shot of this scene, shown in <IMAGE_REF_1>; keep them identical.")
    lines.append("Keep everything else the same.")
    return " ".join(lines)


# ---------------------------------------------------------------- verification


VERIFY_PROMPT = """You check a product placement edit. The image is the approved frame: the products must look like this.
Video 1 is the original shot; video 2 is the edited shot. Answer for video 2:
- productsMatch: every product in the image appears, keeps its shape, colours and design, stays in place for the whole
  shot and does not pop in, vanish or morph between frames. Judge at the video's resolution: small text that is only
  soft is fine; garbled large text, wrong colours or a different product are not;
- newCuts: video 2 has a cut or a jump that video 1 does not;
- peopleChanged: a person's face, body, pose, action or clothing differs from video 1 (clothing the edit replaced excepted);
- note: one short sentence on the most visible problem, or "Looks right" when there is none."""


class _Verdict(BaseModel):
    productsMatch: bool
    newCuts: bool
    peopleChanged: bool
    note: str


# ---------------------------------------------------------------- backends


class OmniVideo:
    name = "gemini"

    def __init__(self):
        from .models import make_vertex_client

        self.client = make_vertex_client(location="global")

    def edit(self, clip: Path, refs: list[tuple[bytes, str]], text: str, resolution: str, aspect: str) -> tuple[bytes, dict]:
        b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
        inputs = [{"type": "video", "data": b64(clip.read_bytes()), "mime_type": "video/mp4"}]
        inputs += [{"type": "image", "data": b64(data), "mime_type": mime} for data, mime in refs]
        inputs.append({"type": "text", "text": text})
        i = with_backoff(lambda: self.client.interactions.create(
            model=OMNI_MODEL, input=inputs,
            response_format={"type": "video", "resolution": resolution, "aspect_ratio": aspect, "delivery": "inline"}))
        v = getattr(i, "output_video", None)
        if v is None or not getattr(v, "data", None):
            raise RuntimeError((getattr(i, "output_text", "") or "Omni returned no video")[:300])
        data = v.data if isinstance(v.data, bytes) else base64.b64decode(v.data)
        u = getattr(i, "usage", None)
        return data, {"input": getattr(u, "total_input_tokens", 0) or 0, "output": getattr(u, "total_output_tokens", 0) or 0}

    def verify(self, original: Path, video: Path, still: bytes) -> dict:
        from google.genai import types

        cfg = types.GenerateContentConfig(response_mime_type="application/json", response_schema=_Verdict)
        clip = lambda p: types.Part.from_bytes(data=p.read_bytes(), mime_type="video/mp4")  # noqa: E731
        parts = [types.Part.from_bytes(data=still, mime_type="image/png"), clip(original), clip(video), VERIFY_PROMPT]
        r = with_backoff(lambda: self.client.models.generate_content(model=VERIFY_MODEL, contents=parts, config=cfg))
        return _Verdict.model_validate_json(r.text).model_dump()


class MockVideo:
    name = "mock"

    def edit(self, clip, refs, text, resolution, aspect):
        return clip.read_bytes(), {"input": 0, "output": 0}

    def verify(self, original, video, still):
        return {"productsMatch": True, "newCuts": False, "peopleChanged": False, "note": "Looks right"}


_BACKEND = None


def get_video_backend():
    global _BACKEND
    kind = os.environ.get("CAMEO_VIDEO", "gemini")
    if kind == "off":
        return None
    if _BACKEND is None or _BACKEND.name != kind:
        _BACKEND = MockVideo() if kind == "mock" else OmniVideo()
    return _BACKEND


# ---------------------------------------------------------------- jobs (one thread per render, state on disk)


_LOCK = threading.Lock()


def _meta_path(out: Path, rid: str) -> Path:
    return out / "renders" / f"{rid}.json"


_ACTIVE: set[str] = set()  # renders running in this process
ON_FINISH: Optional[Callable[[Path, dict], None]] = None  # called with (episode dir, meta) when a render ends


def read(out: Path, rid: str) -> Optional[dict]:
    """A render's state. One marked running that no thread of this process is working on was cut off by a
    server restart: it reads as failed, so the page offers a retry instead of counting up forever."""
    p = _meta_path(out, rid)
    if not p.is_file():
        return None
    meta = json.loads(p.read_text())
    if meta.get("status") == "running" and rid not in _ACTIVE:
        meta.update({"status": "failed", "stage": "failed", "error": "Interrupted: the server restarted while this clip was rendering. Try again."})
    elif meta.get("status") == "failed" and meta.get("error"):
        meta["error"] = friendly(meta["error"])
    return meta


def friendly(err) -> str:
    """Omni's refusals in plain words (from an exception or a stored message); anything else as it came."""
    msg = str(err)
    if "minors" in msg:
        return "Gemini Omni does not edit photorealistic videos of minors, so this shot cannot be rendered."
    if "prohibited_content" in msg or "safety" in msg.lower():
        return "Gemini Omni declined this shot under its content rules."
    if "RESOURCE_EXHAUSTED" in msg or "429" in msg:
        return "Gemini Omni is busy (quota). Try again in a minute."
    return msg[:300]


def _write(out: Path, meta: dict) -> None:
    p = _meta_path(out, meta["id"])
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    tmp.replace(p)


def scene_group(out: Path, shot_id: str) -> str:
    for f in (out / "cache").glob("*/stage1.json"):
        for s in json.loads(f.read_text()):
            if s.get("shotId") == shot_id:
                return s.get("sceneGroup") or ""
    return ""


def continuity_frame(out: Path, req: RenderRequest) -> Optional[bytes]:
    """The middle frame of a finished render of another shot in the same scene, for the same audience."""
    group = scene_group(out, req.shotId)
    if not group:
        return None
    best = None
    for p in (out / "renders").glob("*.json"):
        m = json.loads(p.read_text())
        if m.get("status") == "done" and m.get("audienceId") == req.audienceId and m.get("shotId") != req.shotId and scene_group(out, m["shotId"]) == group:
            if best is None or m.get("finishedAt", 0) > best.get("finishedAt", 0):
                best = m
    return middle_frame(out / "renders" / f"{best['id']}.mp4") if best else None


def _usable(out: Path, meta: dict) -> bool:
    """Running, or done with its clip on disk (a restore can bring back the record without the clip)."""
    return meta["status"] == "running" or (meta["status"] == "done" and (out / "renders" / f"{meta['id']}.mp4").is_file())


def start(out: Path, req: RenderRequest, backend) -> dict:
    """Start (or return) the render for this request. Cached by every input that shapes the result."""
    if not (out / "previews" / f"{req.stillId}.png").is_file():
        raise FileNotFoundError("approve a preview still for this version first")
    clip, dur = clip_for(out, req.shotId)
    # The request itself (whatever continuity frame it ends up with): asking again returns the same render, even
    # after another shot of the scene finished and would now lend a different frame.
    asked = hashlib.sha256(json.dumps([hashlib.sha256(clip.read_bytes()).hexdigest(), req.stillId, instruction(req, False), req.resolution, OMNI_MODEL,
                                       backend.name, req.attempt, req.audienceId]).encode()).hexdigest()[:20]
    with _LOCK:
        for p in (out / "renders").glob("*.json"):
            m = read(out, p.stem)
            if m and m.get("request") == asked and _usable(out, m):
                return m
    cont = continuity_frame(out, req)
    text = instruction(req, cont is not None)
    key = hashlib.sha256(json.dumps([hashlib.sha256(clip.read_bytes()).hexdigest(), req.stillId, text, req.resolution, OMNI_MODEL, backend.name, req.attempt,
                                     hashlib.sha256(cont).hexdigest() if cont else ""]).encode()).hexdigest()[:20]
    with _LOCK:
        meta = read(out, key)
        if meta and _usable(out, meta):
            return meta
        meta = {"id": key, "request": asked, "status": "running", "stage": "rendering", "shotId": req.shotId, "audienceId": req.audienceId, "stillId": req.stillId,
                "resolution": req.resolution, "attempt": req.attempt, "model": OMNI_MODEL, "seconds": round(dur, 2), "startedAt": time.time(), "prompt": text,
                "continuity": cont is not None, "estimate": round(dur * PRICE_PER_S[req.resolution], 3),
                "items": [i.model_dump() for i in req.items]}
        _write(out, meta)
        _ACTIVE.add(key)
    threading.Thread(target=_run_render, args=(out, req, backend, meta, clip, dur, cont), daemon=True).start()
    return meta


def _run_render(out: Path, req: RenderRequest, backend, meta: dict, clip: Path, dur: float, cont: Optional[bytes]) -> None:
    try:
        still = (out / "previews" / f"{req.stillId}.png").read_bytes()
        refs = [(still, "image/png")] + ([(cont, "image/jpeg")] if cont else [])
        ing = json.loads((out / "ingest.json").read_text())
        aspect = "9:16" if int(ing["height"]) > int(ing["width"]) else "16:9"
        t0 = time.monotonic()
        data, usage = backend.edit(clip, refs, meta["prompt"], req.resolution, aspect)
        raw = out / "renders" / f"{meta['id']}.raw.mp4"
        raw.write_bytes(data)
        final = out / "renders" / f"{meta['id']}.mp4"
        finish(raw, out, req.shotId, dur, final)
        cost = round(usage["input"] * 1.5e-6 + usage["output"] * 17.5e-6, 4)
        meta.update({"stage": "verifying", "renderSeconds": round(time.monotonic() - t0, 1), "cost": cost, "usage": usage})
        _write(out, meta)
        try:
            v = backend.verify(clip, final, still)
            v["pass"] = bool(v["productsMatch"] and not v["newCuts"] and not v["peopleChanged"])
        except Exception as e:  # noqa: BLE001  (a failed check never hides a finished clip)
            v = {"pass": None, "note": f"Check unavailable: {str(e)[:120]}"}
        meta.update({"status": "done", "stage": "done", "verify": v, "finishedAt": time.time()})
    except Exception as e:  # noqa: BLE001
        meta.update({"status": "failed", "stage": "failed", "error": friendly(e), "finishedAt": time.time()})
    try:
        _write(out, meta)
    finally:  # never left "running" by a failed write (the episode deleted meanwhile)
        _ACTIVE.discard(meta["id"])
        if ON_FINISH is not None:
            ON_FINISH(out, meta)


def master(out: Path, audience_id: str, render_ids: list[str]) -> Path:
    """The episode for one audience: rendered shots where they exist, the original elsewhere, at the proxy's size.
    Video is joined shot by shot; the audio is the episode's own track, whole (shot timings are unchanged)."""
    ing = json.loads((out / "ingest.json").read_text())
    by_shot = {}
    for rid in render_ids:
        m = read(out, rid)
        # The page sends this audience's renders; a render shared by two audiences (same products, same still) is
        # stored under whichever asked first, so the stored audience is not checked.
        if m and m.get("status") == "done":
            by_shot[m["shotId"]] = out / "renders" / f"{rid}.mp4"
    key = hashlib.sha256(json.dumps([audience_id, sorted((k, str(v)) for k, v in by_shot.items())]).encode()).hexdigest()[:20]
    dest = out / "masters" / f"{key}.mp4"
    with key_lock(f"master/{out.name}/{key}"):  # one build per master; a second request waits and gets the same file
        if dest.is_file():
            if not dest.with_suffix(".jpg").is_file():  # masters built before posters existed
                _run(["ffmpeg", "-v", "error", "-y", "-ss", "0.05", "-i", str(dest), "-frames:v", "1", "-q:v", "3", str(dest.with_suffix(".jpg"))])
            return dest
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f"{key}.part.mp4")
        _build_master(out, ing, by_shot, tmp)
        # the player's poster: this version's own first frame, so Watch never opens on the original picture
        _run(["ffmpeg", "-v", "error", "-y", "-ss", "0.05", "-i", str(tmp), "-frames:v", "1", "-q:v", "3", str(dest.with_suffix(".jpg"))])
        tmp.replace(dest)  # atomic: a reader never sees a half-written file
    return dest


_KEY_LOCKS: dict[str, threading.Lock] = {}


def key_lock(key: str) -> threading.Lock:
    """One lock per file being built (a clip, a master), so parallel requests build it once."""
    with _LOCK:
        return _KEY_LOCKS.setdefault(key, threading.Lock())


def _build_master(out: Path, ing: dict, by_shot: dict, dest: Path) -> None:
    proxy = out / "proxy_360p.mp4"
    pw, ph = (int(x) for x in _run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(proxy)]).strip().split(","))
    inputs, parts = [], []
    for n, s in enumerate(ing["shots"]):
        dur = s["tOut"] - s["tIn"]
        if s["shotId"] in by_shot:
            inputs += ["-i", str(by_shot[s["shotId"]])]
        else:
            inputs += ["-ss", f"{s['tIn']:.3f}", "-t", f"{dur:.3f}", "-i", str(proxy)]
        parts.append(f"[{n}:v]scale={pw}:{ph}:force_original_aspect_ratio=increase,crop={pw}:{ph},setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=1,trim=duration={dur:.3f},setpts=PTS-STARTPTS[v{n}]")
    k = len(ing["shots"])
    graph = ";".join(parts) + ";" + "".join(f"[v{n}]" for n in range(k)) + f"concat=n={k}:v=1:a=0[v]"
    audio = _has_audio(proxy)
    extra = ["-i", str(proxy)] if audio else []
    maps = ["-map", "[v]"] + (["-map", f"{k}:a:0", "-c:a", "aac", "-shortest"] if audio else [])
    _run(["ffmpeg", "-v", "error", "-y", *inputs, *extra, "-filter_complex", graph, *maps, "-c:v", "libx264", "-crf", "23",
          "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(dest)])
