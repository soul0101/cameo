"""Renders: Omni (mock) edits a shot, the clip keeps the shot's length and audio, and the audience master cuts it in."""

import json
import subprocess
import time

from fastapi.testclient import TestClient

from cameo_agents import api, render

ITEM = {"label": "white coffee mug", "kind": "table", "box": {"x": 0.4, "y": 0.6, "w": 0.1, "h": 0.1},
        "product": {"brand": "FizzUp", "name": "Lemon-Lime Soda", "category": "Beverage"}}


def _episode(tmp_path):
    out = tmp_path / "out" / "up-render01"
    out.mkdir(parents=True)
    src = out / "source.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x568:d=4:r=24", "-f", "lavfi", "-i", "sine=d=4",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src)], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-c", "copy", str(out / "proxy_360p.mp4")], check=True)
    (out / "ingest.json").write_text(json.dumps({"video": str(src), "width": 320, "height": 568, "duration": 4.0,
                                                 "shots": [{"shotId": "C01", "tIn": 0, "tOut": 2.0}, {"shotId": "C02", "tIn": 2.0, "tOut": 4.0}]}))
    (out / "previews").mkdir()
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x568", "-frames:v", "1", str(out / "previews" / ("a" * 20 + ".png"))], check=True)
    return out


def _wait(c, url, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = c.get(url).json()
        if j["status"] != "running":
            return j
        time.sleep(0.1)
    raise AssertionError("render never finished")


def test_render_master_and_instruction(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "OUT_ROOT", tmp_path / "out")
    monkeypatch.setenv("CAMEO_VIDEO", "mock")
    out = _episode(tmp_path)
    c = TestClient(api.app)
    body = {"shotId": "C01", "audienceId": "IN", "stillId": "a" * 20, "items": [ITEM], "resolution": "360p"}
    r = c.post("/episodes/up-render01/renders", json=body)
    assert r.status_code == 200, r.text
    j = _wait(c, f"/episodes/up-render01/renders/{r.json()['id']}")
    assert j["status"] == "done" and j["verify"]["pass"] is True and j["url"].endswith(".mp4")
    meta = render.read(out, j["id"])
    assert meta["prompt"].startswith("Single continuous shot, no cuts.") and "<IMAGE_REF_0>" in meta["prompt"] and meta["prompt"].endswith("Keep everything else the same.")
    assert "the white coffee mug is replaced by the FizzUp Lemon-Lime Soda" in meta["prompt"]
    clip = out / "renders" / f"{j['id']}.mp4"
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", str(clip)], capture_output=True, text=True).stdout
    assert abs(float(json.loads(probe)["format"]["duration"]) - 2.0) < 0.1 and '"audio"' in probe
    assert c.post("/episodes/up-render01/renders", json=body).json()["id"] == j["id"]  # cached
    m = c.post("/episodes/up-render01/masters", json={"audienceId": "IN", "renders": [j["id"]]})
    assert m.status_code == 200 and c.get(m.json()["url"]).status_code == 200
    assert c.post("/episodes/up-render01/renders", json={**body, "stillId": "b" * 20}).status_code == 409  # no approved still
