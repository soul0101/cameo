"""Turn a processed episode into a ready-made sample: out/<id>/sample.json, read by GET /samples and the web app.

    .venv/bin/python scripts/make_sample.py <episodeId> --name "Park walk" [--blurb "..."] [--order 1]
        [--render <renderId> ...] [--reverify]

A sample is the episode plus, per version (shot x audience), the products in its boxes, its approved still and its
rendered clip, so a browser that opens it gets Scenes, Previews, Render and Watch filled in. By default each version is
the latest finished render of that shot and audience; --render picks specific ones. Box and product ids come from the
render's stored items; renders made before items were stored are read back from their prompt (box labels from the
detection, product names from the starter catalog). --reverify re-runs Gemini's check on the clip (about $0.01 each).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from cameo_agents import render  # noqa: E402
from cameo_agents.api import load_env  # noqa: E402
from cameo_agents.detected import build_detected  # noqa: E402

WEB = HERE.parent / "web" / "src" / "data"


def starter_products() -> dict[str, str]:
    """Product display name ("Kora Navy Crewneck", "Navy Crewneck") -> starter product id ("kora-in")."""
    brands = json.loads((WEB / "brands.json").read_text())["brands"]
    ts = (WEB / "starterCatalog.ts").read_text()
    short = {m.group(1): dict(re.findall(r"(\w+): '([^']+)'", m.group(2))) for m in re.finditer(r"^\s+(\w+): \{([^}]+)\},?$", ts, re.M)}
    names: dict[str, str] = {}
    for b in brands:
        for market, raw in b["markets"].items():
            pid = f"{b['id']}-{market.lower()}"
            name = short.get(b["id"], {}).get(market) or raw["product"].split(",")[0]
            brand = raw.get("brand") or b["name"]
            for n in (name, f"{brand} {name}", raw["product"].split(",")[0]):
                names[n.lower()] = pid
    return names


PHRASES = [  # render.change_phrase, read backwards: (label, product name)
    (r"^the (?P<label>.+) becomes the (?P<name>.+?), same fit$", None),
    (r"^the wearer of the (?P<label>.+) wears the (?P<name>.+?) \(in its place.*\)$", None),
    (r"^the (?P<label>.+) shows the (?P<name>.+) ad$", None),
    (r"^the (?P<label>.+) is replaced by the (?P<name>.+)$", None),
    (r"^the (?P<name>.+?) (?:sits on|is placed at) the (?P<label>.+?)(?:, resting or hanging as it naturally would there)?$", None),
]


def items_of(meta: dict, boxes: list[dict], names: dict[str, str], still: dict | None = None) -> list[dict]:
    if meta.get("items") and all(i.get("boxId") and i.get("productId") for i in meta["items"]):
        photos = {i.get("boxId"): i.get("imageUrl") for i in (still or {}).get("items", [])}
        # Everything a browser needs to rebuild the version: a drawn box's place and name, the product itself.
        return [{"boxId": i["boxId"], "productId": i["productId"], "box": i["box"], "label": i["label"], "kind": i.get("kind"), "edit": i.get("edit"),
                 "product": {**i["product"], "image": photos.get(i["boxId"])}} for i in meta["items"]]
    changes = meta["prompt"].split(": ", 1)[1].split(". The products")[0]
    out = []
    for part in changes.split("; "):
        m = next((re.match(p, part.strip()) for p, _ in PHRASES if re.match(p, part.strip())), None)
        if not m:
            raise SystemExit(f"cannot read '{part}' in render {meta['id']}")
        label, name = m.group("label").lower(), m.group("name").lower()
        box = next((b for b in boxes if b["shotId"] == meta["shotId"] and b["label"].lower() == label), None)
        pid = names.get(name)
        if box is None or pid is None:
            raise SystemExit(f"render {meta['id']}: no detected box '{label}' or starter product '{name}' (a drawn box cannot be rebuilt)")
        out.append({"boxId": f"g-{box['id']}", "productId": pid})
    return out


def still_meta(out: Path, still_id: str) -> dict | None:
    p = out / "previews" / f"{still_id}.json"
    return json.loads(p.read_text()) if p.is_file() else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("episode")
    ap.add_argument("--name", required=True)
    ap.add_argument("--blurb", default="")
    ap.add_argument("--order", type=int, default=99)
    ap.add_argument("--render", nargs="*", default=[])
    ap.add_argument("--reverify", action="store_true")
    a = ap.parse_args(argv)
    out = HERE / "out" / a.episode
    detected = build_detected(out)
    boxes = [b for b in detected["boxes"] if b["kind"] != "face"]
    names = starter_products()
    metas = [json.loads(f.read_text()) for f in (out / "renders").glob("*.json")]
    done = [m for m in metas if m.get("status") == "done"]
    if a.render:
        chosen = [m for m in done if m["id"] in a.render]
    else:
        latest: dict[tuple, dict] = {}
        for m in sorted(done, key=lambda m: m.get("finishedAt", 0)):
            latest[(m["shotId"], m["audienceId"])] = m
        chosen = list(latest.values())
    if not chosen:
        raise SystemExit("no finished render to make a sample from")
    if a.reverify:
        load_env()  # before the client is built, so it reads the project from .env
    backend = render.get_video_backend() if a.reverify else None
    versions = []
    for m in sorted(chosen, key=lambda m: (m["shotId"], m["audienceId"])):
        clip = out / "renders" / f"{m['id']}.mp4"
        poster = clip.with_suffix(".jpg")
        if not poster.is_file():
            poster.write_bytes(render.middle_frame(clip))
        if backend is not None:
            v = backend.verify(render.clip_for(out, m["shotId"])[0], clip, (out / "previews" / f"{m['stillId']}.png").read_bytes())
            v["pass"] = bool(v["productsMatch"] and not v["newCuts"] and not v["peopleChanged"])
            m["verify"] = v
            (out / "renders" / f"{m['id']}.json").write_text(json.dumps(m, ensure_ascii=False, indent=2))
            print(f"  re-checked {m['id']}: {v['note']}")
        versions.append({"shotId": m["shotId"], "audienceId": m["audienceId"], "stillId": m["stillId"], "renderId": m["id"],
                         "poster": f"/episodes/{a.episode}/renders/{m['id']}.jpg", "assignments": items_of(m, boxes, names, still_meta(out, m["stillId"]))})
    sample = {"name": a.name, "blurb": a.blurb, "order": a.order, "versions": versions}
    tmp = out / "sample.json.part"
    tmp.write_text(json.dumps(sample, ensure_ascii=False, indent=2))
    tmp.replace(out / "sample.json")
    print(f"{a.episode}: {a.name} · {len(versions)} version(s)")
    for v in versions:
        print(f"  {v['shotId']} {v['audienceId']} still {v['stillId']} render {v['renderId']} {v['assignments']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
