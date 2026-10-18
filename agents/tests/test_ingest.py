import json
import subprocess

from cameo_agents.ingest import ingest
from tests.conftest import make_clip


def test_ingest_cuts_at_the_scene_change(tmp_path):
    out = tmp_path / "out"
    r = ingest(make_clip(tmp_path / "clip.mp4", seconds=2.0, cut=True), out)
    assert r.detection.method == "scene" and len(r.shots) == 2 and abs(r.shots[0].tOut - 1.0) < 0.1
    assert r.shots[0].tIn == 0 and abs(r.shots[-1].tOut - r.duration) < 1e-6
    assert (out / "proxy_360p.mp4").exists() and (out / "audio.m4a").exists()
    for s in r.shots:
        assert [k.pos for k in s.keyframes] == ["start", "mid", "end"]
        for k in s.keyframes:
            assert (out / k.path).exists()
    data = json.loads((out / "ingest.json").read_text())
    assert data["detection"]["sceneCutsRaw"] and abs(data["detection"]["sceneCutsRaw"][0] - 1.0) < 0.1
    w = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=width", "-of", "csv=p=0", str(out / r.shots[0].keyframes[0].path)], capture_output=True, text=True).stdout.strip()
    assert w == "720"
