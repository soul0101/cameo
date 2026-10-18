"""detected.json: what the web app's Scenes page reads for an episode (GET /episodes/{id}/detected.json).

    python -m cameo_agents.detected out/<episode> <dest.json>

Folds <out_dir>/web.json (moments, placements, stage-3 suggestions, default prompts) and scenes.json (boxes, skipped
shots, scene facts) into one file.

After POST /episodes/{id}/match, the re-matched web.json/scenes.json live in <out_dir>/match/<matchId>/ and
<out_dir>/match/active names the latest one; build_detected reads that unless a matchId is given ("" = the original run).
`episode.shots[].visionObjects` are the Cloud Vision objects on each shot's mid keyframe (cache/vision/).
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import os
import sys
from pathlib import Path


def _r3(n: float) -> float | int:
    v = math.floor(float(n) * 1000 + 0.5) / 1000  # JS Math.round (half up)
    return int(v) if v == int(v) else v


def _box(b: dict) -> dict:
    return {k: _r3(b[k]) for k in ("x", "y", "w", "h")}


def match_dir(src: Path, match_id: str | None = None) -> Path:
    """Where web.json / scenes.json are read from: match/<id>/ when an id is given, else the original run (src itself).
    The latest match is never served by default, so a public visitor never sees someone else's re-match."""
    d = src / "match" / match_id if match_id else src
    return d if (d / "web.json").is_file() else src


def _episode(src: Path) -> dict | None:
    from .vision import shot_objects

    ip = src / "ingest.json"
    if not ip.exists():
        return None
    ing = json.loads(ip.read_text())
    return {
        "id": ing.get("episodeId") or src.name,
        "duration": _r3(ing["duration"]),
        "width": int(ing["width"]),
        "height": int(ing["height"]),
        "fps": _r3(ing["fps"]),
        "shots": [
            {
                "shotId": s["shotId"],
                "index": int(s["index"]),
                "tIn": _r3(s["tIn"]),
                "tOut": _r3(s["tOut"]),
                "keyframes": [{"pos": k["pos"], "t": _r3(k["t"]), "name": Path(k["path"]).stem} for k in s.get("keyframes", [])],
                "visionObjects": shot_objects(src, s["shotId"]),
            }
            for s in ing.get("shots", [])
        ],
    }


def build_detected(out_dir: str | Path, match_id: str | None = None) -> dict:
    src = Path(out_dir)
    md = match_dir(src, match_id)
    web = json.loads((md / "web.json").read_text())
    sp = md / "scenes.json"
    page = json.loads(sp.read_text()) if sp.exists() else {}
    notes = page.get("boxNotes") or {}
    scenes = web.get("scenes") or page.get("scenes") or []
    boxes = web.get("boxes") or page.get("boxes") or []
    episode = _episode(src)
    out = {
        "episodeId": web.get("episodeId") or src.name,
        "matchId": md.name if md != src else None,
        "audiences": (web.get("audiences") or page.get("regions") or []),
        "llm": web.get("llm"),
        "model": os.environ.get("CAMEO_MODEL") or "gemini-3.8-flash",
        "platform": "Vertex AI",
        "syncedAt": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "moments": web.get("moments") or [],
        "placements": web.get("placements") or [],
        "scenes": [
            {
                "shotId": s["shotId"],
                "tIn": s["tIn"],
                "tOut": s["tOut"],
                "type": (s.get("scene") or {}).get("type") or s.get("type") or "",
                "mood": (s.get("scene") or {}).get("mood") or s.get("mood") or "",
                "tags": (s.get("scene") or {}).get("tags") or s.get("tags") or [],
                "surfaces": len(s["surfaces"]) if isinstance(s.get("surfaces"), list) else (s.get("surfaces") or 0),
                "sensitivity": s.get("sensitivity") or {"level": "none", "reasons": []},
            }
            for s in scenes
        ],
        "boxes": [
            {
                "id": b.get("id"),
                "shotId": b["shotId"],
                "shotIds": b.get("shotIds") or [b["shotId"]],
                "label": b["label"],
                "kind": b["kind"],
                "box": _box(b["box"]),
                "areaPct": b.get("areaPct"),
                "blocked": bool(b.get("blocked")),
                "note": notes.get(b.get("id")),
                "suggestions": (web.get("suggestions") or {}).get(b.get("id")) or {},
                "defaultPrompts": (web.get("defaultPrompts") or {}).get(b.get("id")) or {},
            }
            for b in boxes
            if b["kind"] != "face"
        ],
        "skipped": web.get("skipped") or page.get("skipped") or [],
    }
    if episode:
        out["episode"] = episode
    return out


def main(argv: list[str] | None = None) -> int:
    a = sys.argv[1:] if argv is None else argv
    if len(a) != 2:
        print(__doc__)
        return 2
    out = build_detected(a[0])
    dest = Path(a[1])
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    print(f"detected: {len(out['moments'])} moments · {len(out['boxes'])} boxes · {len(out['scenes'])} scenes · {len(out['skipped'])} skipped → {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
