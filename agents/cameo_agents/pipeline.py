"""Stages 1-3 over an ingest output, with per-stage caching to disk.

    python -m cameo_agents.pipeline out/<episode> [--llm gemini|mock] [--stages 1,2|1,2,3] [--force] [--regions <ids>]
    python -m cameo_agents.pipeline out/<episode> --dry-run [--stages 1,2,3]

Stage 1: Gemini watches the episode's 360p proxy once and describes every shot (scene, mood, people, camera, sensitivity,
surfaces). Stage 2: Gemini boxes those surfaces on each shot's keyframes, with Cloud Vision objects as context; boxes are
guarded against faces and merged across shots. Stage 3: one Gemini call matches catalog products to every box for every
audience and writes the edit prompts (chunked by scene above ~30k prompt tokens).

Writes <out_dir>/cache/<llm>/stage{1,2,3}.json (+ usage.json), masks/<boxId>.json, scenes.json and web.json.
--stages defaults to 1,2; 3 adds matching (stages 1-2 come from cache when present). --dry-run writes every Vertex
request to <out_dir>/requests/ without calling the API.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, TypeVar

from .ingest import extract_frame, keyframe_times, load_ingest
from .models import LLM, DryRunGeminiLLM, GeminiLLM, get_llm
from .schemas import (
    Box,
    IngestResult,
    Keyframe,
    LocalisedFrame,
    NormBox,
    Product,
    RuleSet,
    SceneRerank,
    SceneUnderstanding,
    ScenesPageOutput,
    SkippedScene,
    Suggestion,
    TrackPoint,
    is_skipped,
    to_web_json,
)

HERE = Path(__file__).resolve().parent
DEFAULT_CATALOG = Path(os.environ.get("CAMEO_CATALOG") or HERE.parent.parent / "web" / "src" / "data" / "brands.json")

# Deterministic guards on Gemini's boxes
MIN_SHOT_S = 2.0
MIN_AREA_PCT = 1.5
FACE_OVERLAP_MAX = 0.2  # share of the box covered by a face box
OCCLUSION_MAX = 0.6
MERGE_IOU = 0.6
WORKERS = 8

T = TypeVar("T")


# ---------------------------------------------------------------- caching


def cached(path: Path, force: bool, build: Callable[[], T], dump: Callable[[T], object], load: Callable[[object], T]) -> T:
    if path.exists() and not force:
        return load(json.loads(path.read_text()))
    value = build()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dump(value), indent=2, ensure_ascii=False))
    return value


# ---------------------------------------------------------------- catalog


def web_product_id(brand_id: str, region: str) -> str:
    """Same id the web app gives the product (web/src/data/sampleProducts.ts `sampleProductId`): `brewno-in`."""
    return f"{brand_id}-{region.lower()}"


def load_catalog(path: Path = DEFAULT_CATALOG, regions: list[str] | None = None) -> tuple[list[Product], RuleSet]:
    """brands.json -> one Product per brand per region, ids as the web catalog has them (detected.ts resolves them)."""
    data = json.loads(Path(path).read_text())
    products, exclusions = [], {}
    for b in data["brands"]:
        exclusions[b["id"]] = b.get("exclusions", [])
        for region, m in b.get("markets", {}).items():
            if regions and region not in regions:
                continue
            name = m["product"].strip()  # full pack description: the model writes the default prompt from it
            products.append(Product(id=web_product_id(b["id"], region), line=b["id"], region=region, brand=b["name"], name=name, category=b["category"], fits=b.get("placement_types", []), affinity=b.get("scene_affinity", []), exclusions=b.get("exclusions", [])))
    return products, RuleSet(exclusions=exclusions)


# ---------------------------------------------------------------- stage 1


def stage1(ing: IngestResult, out: Path, llm: LLM, force: bool = False) -> list[SceneUnderstanding]:
    return cached(
        out / "cache" / llm.name / "stage1.json",
        force,
        lambda: llm.understand_scenes(out / ing.proxy, ing.shots),
        lambda v: [s.model_dump() for s in v],
        lambda d: [SceneUnderstanding.model_validate(x) for x in d],
    )


# ---------------------------------------------------------------- stage 2


def _frames_for(ing: IngestResult, out: Path, scene: SceneUnderstanding, skipped: bool) -> list[Keyframe]:
    shot = next(s for s in ing.shots if s.shotId == scene.shotId)
    have = {k.pos: k for k in shot.keyframes}
    # Skipped shots: the mid frame only, for the display box (no matching). Otherwise the shot's three ingest
    # keyframes (start / mid / end), interpolated to mid-shot by build_boxes.
    want = ("mid",) if skipped else ("start", "mid", "end")
    frames = []
    for pos, t in keyframe_times(shot, want):  # type: ignore[arg-type]
        if pos in have:
            frames.append(have[pos])
            continue
        rel = f"keyframes/{shot.shotId}_{pos}.jpg"
        if not (out / rel).exists():
            extract_frame(Path(ing.video), t, out / rel)
        frames.append(Keyframe(shotId=shot.shotId, pos=pos, t=t, path=rel))  # type: ignore[arg-type]
    return frames


def _interpolate(track: list[TrackPoint], t: float) -> NormBox:
    if len(track) == 1 or t <= track[0].t:
        return track[0].box
    for a, b in zip(track, track[1:]):
        if a.t <= t <= b.t:
            return a.box.lerp(b.box, (t - a.t) / (b.t - a.t) if b.t > a.t else 0.0)
    return track[-1].box


def build_boxes(scene: SceneUnderstanding, frames: list[LocalisedFrame], skipped: bool) -> tuple[list[Box], list[Box], dict[str, list[list[float]]]]:
    """Per-label track -> one representative box at mid-shot. Returns (surface boxes, faces, masks by label)."""
    mid_t = (scene.tIn + scene.tOut) / 2
    tracks: dict[str, list[Box]] = {}
    faces: list[Box] = []
    masks: dict[str, tuple[float, list[list[float]]]] = {}
    for lf in frames:
        for b in lf.boxes:
            (faces.append(b) if b.kind == "face" else tracks.setdefault(b.label, []).append(b))
        for label, poly in lf.masks.items():
            t = next((b.t for b in lf.boxes if b.label == label), mid_t)
            if label not in masks or abs(t - mid_t) < abs(masks[label][0] - mid_t):
                masks[label] = (t, poly)
    boxes = []
    for label, obs in tracks.items():
        obs.sort(key=lambda b: b.t)
        track = [TrackPoint(t=b.t, box=b.box) for b in obs]
        rep = _interpolate(track, mid_t)
        first = obs[len(obs) // 2]
        boxes.append(
            Box(
                label=label,
                kind=first.kind,
                shotId=scene.shotId,
                box=rep,
                t=mid_t,
                track=track,
                occludedByHands=max(b.occludedByHands for b in obs),
                textPresent=any(b.textPresent for b in obs),
                salience=max((b.salience for b in obs if b.salience is not None), default=None),
                areaPct=round(rep.area * 100, 2),
                # distance to the nearest face box; if no face was boxed, the model's per-frame nearFace flag (0.0 = near)
                nearFace=min((rep.distance(f.box) for f in faces), default=min((b.nearFace for b in obs if b.nearFace is not None), default=None)),
                blocked=skipped,
            )
        )
    return boxes, faces, {k: v[1] for k, v in masks.items()}


def guard(boxes: list[Box], faces: list[Box]) -> tuple[list[Box], list[dict]]:
    """Drop tiny / face-covered / occluded boxes, merge duplicates (IoU > 0.6). Blocked boxes pass untouched."""
    kept, dropped = [], []
    for b in boxes:
        if b.blocked:
            kept.append(b)
            continue
        reason = None
        if b.areaPct < MIN_AREA_PCT:
            reason = f"area {b.areaPct}% < {MIN_AREA_PCT}%"
        elif any(b.box.intersection(f.box) > FACE_OVERLAP_MAX * b.box.area for f in faces):
            reason = "face inside box"
        elif b.occludedByHands > OCCLUSION_MAX:
            reason = f"occluded {b.occludedByHands:.0%}"
        if reason:
            dropped.append({"shotId": b.shotId, "label": b.label, "reason": reason})
        else:
            kept.append(b)
    merged: list[Box] = []
    for b in sorted(kept, key=lambda b: -(b.salience or 0) - b.box.area):
        dup = next((m for m in merged if m.shotId == b.shotId and m.box.iou(b.box) > MERGE_IOU), None)
        if dup:
            dropped.append({"shotId": b.shotId, "label": b.label, "reason": f"merged into {dup.label} (IoU {dup.box.iou(b.box):.2f})"})
        else:
            merged.append(b)
    return merged, dropped


def merge_across_shots(boxes: list[Box], shot_order: list[str]) -> list[Box]:
    """Same kind, adjacent shots, IoU > 0.6 -> one box spanning both shots (primary = larger box)."""
    pos = {s: i for i, s in enumerate(shot_order)}
    out: list[Box] = []
    for b in sorted(boxes, key=lambda b: (pos[b.shotId], b.label)):
        b = b.model_copy(update={"shotIds": b.shotIds or [b.shotId]})
        prev = next(
            (m for m in out if not m.blocked and not b.blocked and m.kind == b.kind and pos[m.shotIds[-1]] == pos[b.shotId] - 1 and m.box.iou(b.box) > MERGE_IOU),
            None,
        )
        if prev is None:
            out.append(b)
            continue
        out.remove(prev)
        primary, other = (b, prev) if b.box.area >= prev.box.area else (prev, b)
        out.append(primary.model_copy(update={"shotIds": prev.shotIds + [b.shotId], "track": sorted(prev.track + b.track, key=lambda p: p.t)}))
    return out


def stage2(ing: IngestResult, out: Path, llm: LLM, scenes: list[SceneUnderstanding], force: bool = False, workers: int = WORKERS) -> dict:
    def build() -> dict:
        jobs: list[tuple[SceneUnderstanding, Keyframe, bool]] = []
        ignored = []
        for sc in scenes:
            if sc.tOut - sc.tIn < MIN_SHOT_S:
                ignored.append({"shotId": sc.shotId, "reason": f"shot < {MIN_SHOT_S}s"})
                continue
            surfaces = sc.surfaces
            if not surfaces:
                continue
            skipped = is_skipped(sc)
            for kf in _frames_for(ing, out, sc, skipped):
                jobs.append((sc, kf, skipped))
        from .vision import load_objects

        # Cloud Vision objects for the keyframe (cache/vision/<stem>.json), when the vision stage ran
        ctx = lambda kf: load_objects(out, Path(kf.path).stem) or None
        with ThreadPoolExecutor(max_workers=workers) as ex:
            results = list(ex.map(lambda j: llm.localise(j[1], out / j[1].path, j[0].surfaces, ctx(j[1])), jobs))
        per_shot: dict[str, list[LocalisedFrame]] = {}
        for (sc, _, _), r in zip(jobs, results):
            per_shot.setdefault(sc.shotId, []).append(r)
        all_boxes, all_faces, dropped = [], [], list(ignored)
        masks_dir = out / "masks"
        masks_dir.mkdir(exist_ok=True)
        for sc in scenes:
            if sc.shotId not in per_shot:
                continue
            boxes, faces, masks = build_boxes(sc, per_shot[sc.shotId], is_skipped(sc))
            boxes, d = guard(boxes, faces)
            dropped += d
            for i, b in enumerate(boxes, start=1):
                b.id = f"{sc.shotId}-b{i}"
                if b.label in masks:
                    rel = f"masks/{b.id}.json"
                    (out / rel).write_text(json.dumps({"boxId": b.id, "label": b.label, "polygon": masks[b.label]}))
                    b.maskRef = rel
            all_boxes += boxes
            all_faces += faces
        merged = merge_across_shots(all_boxes, [s.shotId for s in scenes])
        return {"boxes": [b.model_dump() for b in merged], "faces": [f.model_dump() for f in all_faces], "dropped": dropped, "frames": len(jobs)}

    return cached(out / "cache" / llm.name / "stage2.json", force, build, lambda v: v, lambda d: d)


# ---------------------------------------------------------------- stage 3


MATCH_PROMPT_TOKEN_CAP = 30_000


def scene_chunks(llm: LLM, scenes: list[SceneUnderstanding], boxes: list[Box], products: list[Product], rules: RuleSet, regions: list[str]) -> list[list[SceneUnderstanding]]:
    """The whole episode in one chunk unless its prompt would exceed ~30k tokens; then greedy groups of consecutive scenes."""
    from .models import GeminiLLM, estimate_tokens

    if not isinstance(llm, GeminiLLM):
        return [scenes]
    size = lambda sc: estimate_tokens(llm.match_request(sc, [b for b in boxes if b.shotId in {s.shotId for s in sc}], products, rules, regions).prompt)
    if size(scenes) <= MATCH_PROMPT_TOKEN_CAP:
        return [scenes]
    chunks: list[list[SceneUnderstanding]] = [[]]
    for sc in scenes:
        if chunks[-1] and size(chunks[-1] + [sc]) > MATCH_PROMPT_TOKEN_CAP:
            chunks.append([])
        chunks[-1].append(sc)
    return chunks


def stage3_single(out: Path, llm: LLM, scenes: list[SceneUnderstanding], boxes: list[Box], products: list[Product], rules: RuleSet, regions: list[str], force: bool = False,
                  cache_name: str = "stage3.json") -> dict:
    """Stage 3: one generate_content per episode (per chunk if the prompt is too large)."""
    def build() -> dict:
        reranks, issues = [], []
        chunks = scene_chunks(llm, scenes, boxes, products, rules, regions)
        for i, chunk in enumerate(chunks):
            ids = {s.shotId for s in chunk}
            tag = "episode" if len(chunks) == 1 else f"chunk{i + 1}"
            reranks += llm.match_episode(chunk, [b for b in boxes if b.shotId in ids], products, rules, regions, tag)
            issues += getattr(llm, "match_issues", [])
        return {"mode": "single", "chunks": len(chunks), "issues": issues, "reranks": [r.model_dump() for r in reranks]}

    return cached(out / "cache" / llm.name / cache_name, force, build, lambda v: v, lambda d: d)


# ---------------------------------------------------------------- whole run


def run(out_dir: str | Path, llm: LLM | str = "gemini", regions: list[str] | None = None, catalog: Path = DEFAULT_CATALOG, force: bool = False, media_prefix: str = "",
        stages: tuple[int, ...] = (1, 2, 3), dry_run: bool = False, force_stage3: bool = False,
        products: list[Product] | None = None, rules: RuleSet | None = None, stage3_cache: str = "stage3.json", write_to: Path | None = None) -> tuple[ScenesPageOutput, dict]:
    """Stages 1 and 2 always run (stage 1 feeds stage 2); stage 3 only when 3 is in `stages`.

    products/rules/regions: the browser's catalog expanded per audience (catalog.to_products; regions = audience ids)
    instead of brands.json; stage3_cache names its stage-3 cache file; write_to puts scenes.json/web.json elsewhere.
    dry_run: build every Vertex request into <out>/requests/ (no API call, no scenes.json/web.json written);
    the returned `web` is the request index instead of the web export."""
    out = Path(out_dir).resolve()
    if dry_run:
        llm = DryRunGeminiLLM(out / "requests", model=os.environ.get("CAMEO_MODEL", "gemini-3.8-flash"))
        force = True
    elif isinstance(llm, str):
        llm = get_llm(llm)
    ing = load_ingest(out)
    if products is None:
        products, rules = load_catalog(catalog, regions)
    rules = rules or RuleSet()
    regions = regions or list(dict.fromkeys(p.region for p in products))

    scenes = stage1(ing, out, llm, force)
    s2 = stage2(ing, out, llm, scenes, force)
    skipped_ids = {s.shotId for s in scenes if is_skipped(s)}
    # the skip rule may be stricter than when stage 2 was cached: a box in a skipped shot is blocked
    boxes = [b.model_copy(update={"blocked": True}) if b.shotId in skipped_ids and not b.blocked else b for b in (Box.model_validate(x) for x in s2["boxes"])]
    if 3 not in stages:
        s3 = {"reranks": []}
    else:
        s3 = stage3_single(out, llm, scenes, boxes, products, rules, regions, force or force_stage3, stage3_cache)
    reranks = [SceneRerank.model_validate(r) for r in s3["reranks"]]
    if isinstance(llm, GeminiLLM) and not dry_run and llm.usage:
        stage3_only = all(r["stage"].startswith("stage3") for r in llm.usage)
        (out / "cache" / llm.name / (("usage-stage3.json" if stage3_cache == "stage3.json" else f"usage-{Path(stage3_cache).stem}.json") if stage3_only else "usage.json")).write_text(json.dumps({"stages": list(stages), "location": llm.location, "model": llm.model, **llm.usage_summary()}, indent=2))

    suggestions: dict[str, list[Suggestion]] = {r: [] for r in regions}
    prompts: dict[str, dict[str, str]] = {r: {} for r in regions}
    notes: dict[str, str] = {}
    for rr in reranks:
        notes.update(rr.boxNotes)
        for s in rr.suggestions:
            suggestions.setdefault(s.region, []).append(s)
            prompts.setdefault(s.region, {})[s.boxId] = s.defaultPrompt
    for b in boxes:
        if b.blocked:
            notes.setdefault(b.id, "; ".join(next(s for s in scenes if s.shotId == b.shotId).sensitivity.reasons))
    skipped = [SkippedScene(shotId=s.shotId, tIn=s.tIn, tOut=s.tOut, reasons=s.sensitivity.reasons) for s in scenes if is_skipped(s)]
    keyframes = {s.shotId: next((k.path for k in s.keyframes if k.pos == "mid"), s.keyframes[0].path if s.keyframes else "") for s in ing.shots}
    page = ScenesPageOutput(episodeId=ing.episodeId, regions=regions, scenes=scenes, boxes=boxes, suggestions=suggestions, prompts=prompts, skipped=skipped, boxNotes=notes, keyframes=keyframes, llm=llm.name)
    if isinstance(llm, DryRunGeminiLLM):
        index = {"requestsDir": str(llm.requests_dir), "model": llm.model, "location": llm.location, "project": llm.project, "stages": list(stages), "requests": sorted(llm.index, key=lambda r: r["stage"])}
        (llm.requests_dir / "index.json").write_text(json.dumps(index, indent=2))
        return page, index
    web = to_web_json(page, media_prefix=media_prefix)
    dest = Path(write_to) if write_to else out
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "scenes.json").write_text(page.model_dump_json(indent=2))
    (dest / "web.json").write_text(json.dumps(web, indent=2, ensure_ascii=False))
    return page, web


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m cameo_agents.pipeline", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out_dir", help="an ingest output directory (contains ingest.json)")
    ap.add_argument("--llm", choices=["gemini", "mock"], default="gemini")
    ap.add_argument("--regions", default="", help="comma list, default: every region in the catalog")
    ap.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    ap.add_argument("--force", action="store_true", help="ignore cached stages")
    ap.add_argument("--media-prefix", default="", help="prefix for keyframe paths in web.json")
    ap.add_argument("--stages", default="1,2", help="1,2 (default: scenes + boxes) or 1,2,3 / 3 (adds product matching)")
    ap.add_argument("--force-stage3", action="store_true", help="re-run stage 3 only (stages 1-2 stay cached)")
    ap.add_argument("--dry-run", action="store_true", help="write every Vertex request to <out_dir>/requests/ without calling the API")
    a = ap.parse_args(argv)
    regions = [r.strip() for r in a.regions.split(",") if r.strip()] or None
    stages = tuple(sorted({int(x) for x in a.stages.split(",") if x.strip()} | {1, 2}))
    if not set(stages) <= {1, 2, 3}:
        ap.error("--stages takes 1,2 or 1,2,3")
    page, web = run(a.out_dir, a.llm, regions, Path(a.catalog), a.force, a.media_prefix, stages, a.dry_run, a.force_stage3)
    if a.dry_run:
        print(f"dry run ({web['model']} @ {web['location']}, project {web['project']}): {len(web['requests'])} request entries in {web['requestsDir']}")
        for r in web["requests"]:
            print(f"  {r['stage']:<18} {r['bytes'] / 1e6:6.2f} MB  ~{r['total']:>6} tok (prompt {r['promptText']}, schema {r['schema']}, media {r['media']})")
        return 0
    print(f"{page.episodeId} [{page.llm}]: {len(page.scenes)} shots, {len(page.boxes)} boxes, {len(web['moments'])} moments, {len(web['placements'])} placements")
    print(f"skipped: {[(s.shotId, s.reasons) for s in page.skipped]}")
    for m in web["moments"]:
        print(f"  {m['id']:>3} {m['shotId']} {'+'.join(m['shotIds']):<8} {m['mode']:<8} {m['surface']:<9} {str(m['brandId']):<9} {m['label']}")
    print(f"wrote {Path(a.out_dir) / 'scenes.json'} and web.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
