"""Copy every sample episode's processed output into samples/, which the Docker image serves as read-only episodes.

    .venv/bin/python scripts/pack_samples.py

A sample is an episode with out/<id>/sample.json (scripts/make_sample.py). Only what it shows is kept: the detection
output and its caches, the proxy, keyframes, tracks, shot clips, masters, and the stills and renders its versions use.
The source video is left out: samples are read-only, so nothing re-processes them.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
OUT = HERE / "out"
DEST = HERE / "samples"

FILES = ("ingest.json", "scenes.json", "web.json", "sample.json", "proxy_360p.mp4")
DIRS = ("keyframes", "frames", "cache", "tracks", "masks", "identify", "prompts", "refs", "match", "clips", "masters")


def pack(src: Path, dest: Path) -> int:
    sample = json.loads((src / "sample.json").read_text())
    for name in FILES:
        if (src / name).is_file():
            shutil.copy2(src / name, dest / name)
    for name in DIRS:
        if (src / name).is_dir():
            shutil.copytree(src / name, dest / name)
    for v in sample["versions"]:
        (dest / "previews").mkdir(exist_ok=True)
        for ext in ("png", "json"):
            shutil.copy2(src / "previews" / f"{v['stillId']}.{ext}", dest / "previews")
        if v.get("renderId"):
            (dest / "renders").mkdir(exist_ok=True)
            for ext in ("mp4", "jpg", "json"):
                if (src / "renders" / f"{v['renderId']}.{ext}").is_file():
                    shutil.copy2(src / "renders" / f"{v['renderId']}.{ext}", dest / "renders")
    ing = json.loads((dest / "ingest.json").read_text())
    ing["video"] = ""  # the source stays behind; readers fall back to the proxy
    (dest / "ingest.json").write_text(json.dumps(ing, indent=2, ensure_ascii=False))
    return sum(f.stat().st_size for f in dest.rglob("*") if f.is_file())


def main() -> int:
    shutil.rmtree(DEST, ignore_errors=True)
    total = 0
    for meta in sorted(OUT.glob("*/sample.json")):
        dest = DEST / meta.parent.name
        dest.mkdir(parents=True)
        size = pack(meta.parent, dest)
        total += size
        print(f"{meta.parent.name}: {json.loads(meta.read_text())['name']} · {size / 1e6:.1f} MB")
    print(f"{total / 1e6:.1f} MB in {DEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
