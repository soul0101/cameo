"""Box tracks on synthetic frames: a textured patch sliding over a static background (no video files, no models
beyond the bundled ViT tracker)."""

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from cameo_agents import tracking  # noqa: E402

W, H, N, FPS = 640, 360, 60, 24.0
PATCH = 64


def frames(step=4, start_x=120, y=140):
    rng = np.random.default_rng(0)
    bg = (rng.integers(40, 90, (H, W, 3))).astype(np.uint8)  # dull, static
    patch = rng.integers(0, 255, (PATCH, PATCH, 3)).astype(np.uint8)  # bright, textured
    out = []
    for i in range(N):
        f = bg.copy()
        x = start_x + step * i
        if x + PATCH <= W:
            f[y:y + PATCH, x:x + PATCH] = patch
        out.append(f)
    return out


def true_box(i, step=4, start_x=120, y=140):
    return {"x": (start_x + step * i) / W, "y": y / H, "w": PATCH / W, "h": PATCH / H}


def iou(a, b):
    ix = max(0, min(a[0] + a[2], b["x"] + b["w"]) - max(a[0], b["x"]))
    iy = max(0, min(a[1] + a[3], b["y"] + b["h"]) - max(a[1], b["y"]))
    i = ix * iy
    return i / (a[2] * a[3] + b["w"] * b["h"] - i)


def test_follows_a_moving_patch_both_ways():
    fr = frames()
    t_anchor = 30 / FPS
    tr = tracking.track(fr, FPS, 0.0, [(t_anchor, true_box(30))], [], t_anchor)
    assert tr["fps"] == tracking.OUT_FPS and tr["t0"] == 0.0
    for k in (1, 10, 20):  # 0.1 s, 1.0 s, 2.0 s (frames 2, 24, 48)
        i = round(k / tracking.OUT_FPS * FPS)
        assert tr["boxes"][k] is not None and iou(tr["boxes"][k], true_box(i)) > 0.5, k


def test_hidden_past_a_keyframe_where_gemini_did_not_see_it():
    fr = frames()
    t_anchor = 30 / FPS
    miss = 45 / FPS
    tr = tracking.track(fr, FPS, 0.0, [(t_anchor, true_box(30))], [miss], t_anchor)
    after = [b for k, b in enumerate(tr["boxes"]) if k / tracking.OUT_FPS > miss + 0.05]
    assert after and all(b is None for b in after)
    assert tr["boxes"][int(t_anchor * tracking.OUT_FPS)] is not None


def test_hidden_once_the_patch_leaves_the_frame():
    fr = frames(step=9, start_x=300)  # gone after about frame 37
    t_anchor = 10 / FPS
    tr = tracking.track(fr, FPS, 0.0, [(t_anchor, true_box(10, step=9, start_x=300))], [], t_anchor)
    assert tr["boxes"][-1] is None


def test_track_endpoint_rejects_bad_input(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from cameo_agents import api

    monkeypatch.setattr(api, "OUT_ROOT", tmp_path)
    c = TestClient(api.app)
    assert c.post("/episodes/up-12345678/track", json={"shotId": "C01", "t": 1, "box": {"x": 2}}).status_code == 400
    assert c.post("/episodes/up-12345678/track", json={"shotId": "C01", "t": 1, "box": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}}).status_code == 404
    assert c.get("/episodes/up-12345678/tracks").status_code == 404
