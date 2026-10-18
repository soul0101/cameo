"""Box tracks: where each spot is in every frame of its shot, so the Scenes overlay follows the video.

Gemini boxes a spot on a few keyframes of a shot (start, middle, end). Between and around them a CPU tracker
(OpenCV's ViT tracker; `models/vittrack.onnx` is object_tracking_vittrack_2023sep.onnx from opencv_zoo, Apache-2.0) carries the box frame by frame, both ways from each keyframe
where Gemini saw it. A tracked box is trusted only while it still is the thing Gemini boxed:

  - the tracker is confident (its score stays up),
  - it looks like the keyframe crop (colour histogram), keeps a plausible size and stays in the frame,
  - and it never crosses a keyframe where Gemini looked and did not see it (the spot is out of view there).

Past the first doubt the box is hidden for the rest of that direction, so a lost box never wanders over the
scenery: the overlay fades it out and the page says when it comes into view. A Gemini keyframe box that
disagrees with the track at that moment (Gemini named a different wall) is not used as an anchor.

Output per box (normalised, 10 per second from the shot's start):
    {"t0": tIn, "fps": 10, "boxes": [[x, y, w, h] | null, ...], "best": t}
where null means out of view and `best` is the time the spot is largest in view. Cached under
out/<episode>/tracks/<hash>.json; free (CPU only), about a second per box for a 10 s shot.
"""

from __future__ import annotations

import hashlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

import numpy as np

VERSION = 1
MODEL = Path(__file__).parent / "models" / "vittrack.onnx"
WIDTH = 640  # frames are tracked at this width
OUT_FPS = 10
MIN_SCORE = 0.3  # tracker confidence below this: lost
MIN_LOOK = 0.35  # histogram correlation with the keyframe crop below this: lost
MIN_RUN_S = 0.3  # shorter glimpses are not shown
MAX_GAP_S = 0.5  # shorter doubts between two sightings are bridged
NEAR_S = 0.15  # a Gemini box this close to a keyframe belongs to it

_FRAMES: dict[tuple, tuple[list, float, float]] = {}
_FRAMES_LOCK = threading.Lock()
_BUSY = threading.Semaphore(4)  # at most this many tracks at once (CPU)


def _cv2():
    import cv2  # imported lazily: the API starts without OpenCV loaded

    return cv2


def shot_frames(video: Path, t_in: float, t_out: float) -> tuple[list, float, float]:
    """The shot's frames at WIDTH px (BGR), their fps and the first frame's time. The last shot's are kept for its other boxes."""
    key = (str(video), round(t_in, 3), round(t_out, 3))
    with _FRAMES_LOCK:
        if key in _FRAMES:
            return _FRAMES[key]
    cv2 = _cv2()
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    cap.set(cv2.CAP_PROP_POS_MSEC, t_in * 1000)
    frames, t0 = [], None
    while True:
        ok, f = cap.read()
        if not ok:
            break
        t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000 - 1 / fps
        if t0 is None:
            t0 = max(t_in, t)
        if t > t_out:
            break
        h = int(round(f.shape[0] * WIDTH / f.shape[1] / 2) * 2)
        frames.append(cv2.resize(f, (WIDTH, h), interpolation=cv2.INTER_AREA))
    cap.release()
    out = (frames, float(fps), float(t0 if t0 is not None else t_in))
    with _FRAMES_LOCK:
        _FRAMES.clear()  # one shot at a time: a 10 s vertical shot is about 0.5 GB of frames
        _FRAMES[key] = out
    return out


def _hist(cv2, img, b) -> Optional[np.ndarray]:
    x, y, w, h = (int(round(v)) for v in b)
    H, W = img.shape[:2]
    x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    hsv = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [30, 32], [0, 180, 0, 256])
    return cv2.normalize(hist, hist).flatten()


def _iou(a, b) -> float:
    ix = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    i = ix * iy
    return i / (a[2] * a[3] + b[2] * b[3] - i + 1e-9)


def _tracker(cv2):
    p = cv2.TrackerVit_Params()
    p.net = str(MODEL)
    return cv2.TrackerVit_create(p)


def propagate(frames: list, i0: int, seed, stop: int, step: int) -> dict[int, tuple]:
    """Track `seed` from frame i0 towards `stop` (exclusive); the frames where it is still trusted."""
    cv2 = _cv2()
    H, W = frames[0].shape[:2]
    ref = _hist(cv2, frames[i0], seed)
    area0 = seed[2] * seed[3]
    tr = _tracker(cv2)
    tr.init(frames[i0], tuple(int(round(v)) for v in seed))
    out = {i0: tuple(seed)}
    i = i0
    doubts = 0
    while (i + step - stop) * step < 0:
        i += step
        ok, b = tr.update(frames[i])
        b = tuple(float(v) for v in b)
        good = ok and tr.getTrackingScore() >= MIN_SCORE and 0.25 <= (b[2] * b[3]) / max(area0, 1) <= 4
        cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
        good = good and 0 <= cx <= W and 0 <= cy <= H
        if good and ref is not None:
            h = _hist(cv2, frames[i], b)
            good = h is not None and cv2.compareHist(ref, h, cv2.HISTCMP_CORREL) >= MIN_LOOK
        doubts = 0 if good else doubts + 1
        if doubts >= 2:  # two doubtful frames in a row: lost for the rest of this direction
            break
        if good:
            out[i] = b
    return out


def _smooth(rows: np.ndarray, sigma: float = 2.0) -> np.ndarray:
    """Zero-lag Gaussian over centre and size, within one visible run."""
    if len(rows) < 3:
        return rows
    k = np.exp(-0.5 * (np.arange(-4, 5) / sigma) ** 2)
    k /= k.sum()
    c = np.c_[rows[:, 0] + rows[:, 2] / 2, rows[:, 1] + rows[:, 3] / 2, rows[:, 2], rows[:, 3]]
    pad = np.pad(c, ((4, 4), (0, 0)), mode="edge")
    c = np.stack([np.convolve(pad[:, j], k, mode="valid") for j in range(4)], 1)
    return np.c_[c[:, 0] - c[:, 2] / 2, c[:, 1] - c[:, 3] / 2, c[:, 2], c[:, 3]]


def track(frames: list, fps: float, t0: float, anchors: list[tuple[float, dict]], misses: list[float], main_t: float) -> dict:
    """One box through its shot. `anchors`: (t, normalised box) where Gemini saw it; `misses`: keyframe times where
    Gemini looked and did not; `main_t`: the anchor the box was chosen on (trusted first)."""
    n = len(frames)
    H, W = frames[0].shape[:2]
    idx = lambda t: int(min(n - 1, max(0, round((t - t0) * fps))))  # noqa: E731
    px = lambda b: (b["x"] * W, b["y"] * H, b["w"] * W, b["h"] * H)  # noqa: E731
    anchors = sorted(anchors, key=lambda a: (abs(a[0] - main_t) > NEAR_S, a[0]))  # the main anchor first
    barriers = sorted({idx(t) for t in misses})
    used: list[tuple[int, dict[int, tuple]]] = []
    for t, box in anchors:
        i0, seed = idx(t), px(box)
        if seed[2] < 4 or seed[3] < 4:
            continue
        # Gemini named something else here (a different wall): the track so far disagrees, skip this keyframe box.
        if any(i0 in got and _iou(got[i0], seed) < 0.3 for _, got in used):
            continue
        back = max([b for b in barriers if b < i0], default=-1)
        ahead = min([b for b in barriers if b > i0], default=n)
        got = {**propagate(frames, i0, seed, back, -1), **propagate(frames, i0, seed, ahead, 1)}
        used.append((i0, got))
    rows: list[Optional[np.ndarray]] = []
    for i in range(n):
        cands = [(abs(i - i0), got[i]) for i0, got in used if i in got]
        if not cands:
            rows.append(None)
            continue
        w = np.array([1 / (d + 1) for d, _ in cands])
        rows.append((np.array([b for _, b in cands], float) * w[:, None]).sum(0) / w.sum())
    # a short doubt between two sightings (a hand passing, a blur) is bridged: the box glides across it
    vis = np.array([r is not None for r in rows])
    i = 0
    while i < n:
        if vis[i]:
            i += 1
            continue
        j = i
        while j < n and not vis[j]:
            j += 1
        if 0 < i and j < n and (j - i) / fps <= MAX_GAP_S:
            for k in range(i, j):
                u = (k - i + 1) / (j - i + 1)
                rows[k] = rows[i - 1] * (1 - u) + rows[j] * u
            vis[i:j] = True
        i = j
    # visible runs: drop glimpses, smooth each run
    i = 0
    while i < n:
        if not vis[i]:
            i += 1
            continue
        j = i
        while j < n and vis[j]:
            j += 1
        if (j - i) / fps < MIN_RUN_S:
            vis[i:j] = False
        else:
            sm = _smooth(np.array(rows[i:j]))
            for k in range(i, j):
                rows[k] = sm[k - i]
        i = j
    step = fps / OUT_FPS
    out, best, best_area = [], None, 0.0
    for k in range(int(n / step)):
        i = min(n - 1, int(round(k * step)))
        if not vis[i]:
            out.append(None)
            continue
        x, y, w, h = rows[i]
        x0, y0, x1, y1 = max(0.0, x), max(0.0, y), min(float(W), x + w), min(float(H), y + h)
        b = [round(x0 / W, 4), round(y0 / H, 4), round((x1 - x0) / W, 4), round((y1 - y0) / H, 4)]
        out.append(b)
        if b[2] * b[3] > best_area:
            best, best_area = round(t0 + k / OUT_FPS, 2), b[2] * b[3]
    return {"t0": round(t0, 3), "fps": OUT_FPS, "boxes": out, "best": best if best is not None else round(main_t, 2)}


def _video(out: Path, ing: dict) -> Path:
    src = Path(ing.get("video") or "")
    if src.is_file():
        return src
    return next(out.glob("source.*"), None) or out / "proxy_360p.mp4"


def _shot(ing: dict, shot_id: str) -> dict:
    s = next((s for s in ing["shots"] if s["shotId"] == shot_id), None)
    if s is None:
        raise FileNotFoundError(f"no shot {shot_id}")
    return s


def _cached(out: Path, key_parts: list, make) -> dict:
    key = hashlib.sha256(json.dumps([VERSION, *key_parts]).encode()).hexdigest()[:20]
    p = out / "tracks" / f"{key}.json"
    if p.is_file():
        return json.loads(p.read_text())
    with _BUSY:
        if p.is_file():
            return json.loads(p.read_text())
        res = make()
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".part")
        tmp.write_text(json.dumps(res))
        tmp.replace(p)
        return res


def box_track(out: Path, shot_id: str, anchors: list[tuple[float, dict]], misses: list[float], main_t: float) -> dict:
    ing = json.loads((out / "ingest.json").read_text())
    shot = _shot(ing, shot_id)
    norm = lambda b: [round(float(b[k]), 4) for k in ("x", "y", "w", "h")]  # noqa: E731
    parts = [ing.get("episodeId"), shot_id, shot["tIn"], shot["tOut"], [[round(t, 3), norm(b)] for t, b in anchors], sorted(round(m, 3) for m in misses), round(main_t, 3)]

    def make():
        frames, fps, t0 = shot_frames(_video(out, ing), shot["tIn"], shot["tOut"])
        return track(frames, fps, t0, anchors, misses, main_t)

    return _cached(out, parts, make)


def detected_tracks(out: Path, boxes: list[dict]) -> dict[str, dict]:
    """Tracks for Gemini's boxes (detected.json `boxes`), by box id. Keyframes where Gemini saw other things in the
    shot but not this box count as misses."""
    ing = json.loads((out / "ingest.json").read_text())
    jobs = []
    for b in boxes:
        if b.get("kind") == "face" or b.get("blocked"):
            continue
        shot = next((s for s in ing["shots"] if s["shotId"] == b["shotId"]), None)
        if shot is None:
            continue
        pts = [(float(p["t"]), p["box"]) for p in b.get("track") or []] or [(float(b.get("t", (shot["tIn"] + shot["tOut"]) / 2)), b["box"])]
        seen = [t for t, _ in pts]
        looked = [float(k["t"]) for k in shot.get("keyframes", [])]
        misses = [t for t in looked if all(abs(t - s) > NEAR_S for s in seen)]
        jobs.append((b["id"], b["shotId"], pts, misses, float(b.get("t", pts[0][0]))))
    res = {}
    # One shot at a time (its frames are decoded once and shared), its boxes in parallel: memory stays at one shot.
    for shot_id in dict.fromkeys(j[1] for j in jobs):
        with ThreadPoolExecutor(max_workers=4) as ex:
            futs = {bid: ex.submit(box_track, out, shot, pts, misses, main_t) for bid, shot, pts, misses, main_t in jobs if shot == shot_id}
            for bid, f in futs.items():
                try:
                    res[bid] = f.result()
                except Exception:  # noqa: BLE001  (a box without a track simply stays where Gemini put it)
                    pass
    return res
