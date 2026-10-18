import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def make_clip(path: Path, seconds: float = 3.0, cut: bool = False) -> Path:
    """A portrait clip with a sine tone: one red shot, or with `cut` a hard cut halfway to blue."""
    ff = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    tone = ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
    enc = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)]
    if cut:
        half = seconds / 2
        subprocess.run([*ff, "-f", "lavfi", "-i", f"color=c=red:s=320x568:d={half}:r=24", "-f", "lavfi", "-i", f"color=c=blue:s=320x568:d={half}:r=24",
                        *tone, "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a", *enc], check=True)
    else:
        subprocess.run([*ff, "-f", "lavfi", "-i", f"color=c=red:s=320x568:d={seconds}:r=24", *tone, *enc], check=True)
    return path


@pytest.fixture()
def ingested(tmp_path):
    """An episode ingested from a generated 6 s clip with two 3 s shots: its out dir."""
    from cameo_agents.ingest import ingest

    out = tmp_path / "ep"
    ingest(make_clip(tmp_path / "clip.mp4", seconds=6.0, cut=True), out, episode_id="ep")
    return out
