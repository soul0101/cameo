"""Identify a box the user drew on the Scenes page: one Gemini call on the shot's mid keyframe.

The web app sends the shot, the box (0-1 fractions of the frame), its audiences and its catalog. Gemini gets the keyframe,
the box as box_2d, the scene's stage-1 understanding, the Cloud Vision objects around the box, and the products each
audience may see (catalog.eligible), and answers with what the object is in the context of the scene, why a product
suits it, up to 3 picks per audience and an edit prompt per audience. ~1.5k prompt tokens + one 720 px image: about
$0.002 a call. Answers are cached per (episode, shot, box, catalog hash, audience ids) in out/<episode>/identify/.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from pydantic import BaseModel, Field

from .catalog import Audience, CatalogProduct, audience_lines, catalog_hash, eligible
from .models import PLACEMENT_RULES, PROMPT_STYLE
from .vision import describe, near_box, shot_objects, snap_box


class _GProductPick(BaseModel):
    productId: str = Field(description="a product id listed for this audience")
    why: str = Field(description="one short line (max 12 words) on why it fits this spot")


class _GAudiencePick(BaseModel):
    audienceId: str
    products: list[_GProductPick] = Field(description="at most 3, best first; empty when nothing listed fits")
    prompt: str = Field(description="one-sentence edit prompt for the top pick; empty when no products")


class _GIdentify(BaseModel):
    label: str = Field(description="the object in the box, as a short noun phrase in sentence case, e.g. 'Wooden chair by the window'")
    kind: str = Field(description="one word: chair, table, wall, shelf, counter, screen, sign, bag, hand, apparel, floor, other")
    edit: str = Field(description="how a product would appear here: replace (swap the object or garment), place (set a product on it) or display (show an image on it)")
    why: str = Field(description="one or two plain sentences: what the spot is in this scene and how a product could appear there (replaced, placed or displayed), and which kind of product")
    picks: list[_GAudiencePick] = Field(description="one entry per audience")


IDENTIFY_PROMPT = """You are placing products into a finished film shot. The user drew a box on the frame.
Box (box_2d, [ymin, xmin, ymax, xmax] normalised to 0-1000): {box}

Scene, from an earlier pass over the video: {scene}

Objects Cloud Vision found in or around the box (name, score, box as 0-1 x/y/w/h; context only): {objects}

Look at the image. Say what the object or surface inside the box is, in the context of the whole scene
(not just the pixels: whose it is, where it sits, what it is next to). Then decide how a product could appear there, and
for every audience pick up to 3 products listed for that audience that would look natural. Only use ids listed under
that audience; return an empty list when none would look natural.
""" + PLACEMENT_RULES + """
For each audience also write one edit prompt for its top pick: """ + PROMPT_STYLE + """

AUDIENCES (id: name (kind)):
{audiences}

CATALOG per audience (id · brand · product · category):
{catalog}"""


def _box_2d(b: dict) -> list[int]:
    return [round(b["y"] * 1000), round(b["x"] * 1000), round((b["y"] + b["h"]) * 1000), round((b["x"] + b["w"]) * 1000)]


def cache_key(shot_id: str, box: dict, catalog: list[CatalogProduct], audiences: list[Audience]) -> str:
    doc = [shot_id, [round(box[k], 3) for k in ("x", "y", "w", "h")], catalog_hash(catalog, audiences), sorted(a.id for a in audiences)]
    return hashlib.sha1(json.dumps(doc).encode()).hexdigest()[:16]


def identify(out: Path, llm, shot_id: str, box: dict, audiences: list[Audience], catalog: list[CatalogProduct]) -> dict:
    """The model's read of a drawn box, cached. Returns {label, kind, why, picks, prompts, vision: {objects}}."""
    cache = out / "identify" / f"{cache_key(shot_id, box, catalog, audiences)}.json"
    if cache.is_file():
        return json.loads(cache.read_text())

    frame = out / "keyframes" / f"{shot_id}_mid.jpg"
    if not frame.is_file():
        raise FileNotFoundError(f"no keyframe for {shot_id}")
    scene = "unknown"
    scenes_file = out / "scenes.json"
    if scenes_file.is_file():
        s = next((x for x in json.loads(scenes_file.read_text()).get("scenes", []) if x.get("shotId") == shot_id), None)
        if s:
            scene = json.dumps({k: s.get(k) for k in ("scene", "people", "surfaces", "dialogueCues") if k in s}, ensure_ascii=False)
    objs = shot_objects(out, shot_id)
    # A loosely drawn box snaps to the Cloud Vision object it mostly covers, so a replace edit gets the whole object.
    box, snapped_to = snap_box(objs, box)
    near = near_box(objs, box)
    names = list(dict.fromkeys(o["name"] for o in near))
    allowed = {a.id: [p.id for p in catalog if eligible(p, a.id, audiences)] for a in audiences}
    by_id = {p.id: p for p in catalog}
    cat_lines = []
    for a in audiences:
        cat_lines.append(f"[{a.id}]")
        cat_lines += [f"- {i} · {by_id[i].brand} · {by_id[i].name}" + (f" ({by_id[i].description})" if by_id[i].description else "") + f" · {by_id[i].category}" for i in allowed[a.id]] or ["- (no products for this audience)"]
    prompt = IDENTIFY_PROMPT.format(box=_box_2d(box), scene=scene, objects=describe(near), audiences=audience_lines(audiences), catalog="\n".join(cat_lines))

    raw = llm.identify_box(frame, prompt, {"schema": _GIdentify, "eligible": allowed, "objects": names})
    g = _GIdentify.model_validate(raw)

    picks: dict[str, list[dict]] = {a.id: [] for a in audiences}
    prompts: dict[str, str] = {a.id: "" for a in audiences}
    for row in g.picks:
        if row.audienceId not in picks or picks[row.audienceId]:
            continue
        ok = set(allowed[row.audienceId])
        chosen = []
        for p in row.products:
            if p.productId in ok and p.productId not in {c["productId"] for c in chosen}:
                chosen.append({"productId": p.productId, "why": p.why.strip()})
        picks[row.audienceId] = chosen[:3]
        prompts[row.audienceId] = row.prompt.strip() if chosen else ""
    answer = {"label": g.label.strip()[:80], "kind": g.kind, "edit": g.edit if g.edit in ("replace", "place", "display") else "replace", "why": g.why.strip(), "picks": picks, "prompts": prompts, "vision": {"objects": names, "snappedTo": snapped_to}, "box": box}
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(answer, ensure_ascii=False, indent=2))
    return answer


# ---------------------------------------------------------------- an edit prompt for any product the producer puts in a box


class _GPrompt(BaseModel):
    prompt: str = Field(description="the one-sentence edit prompt")


WRITE_PROMPT = """You are placing a product into a finished film shot. The spot is the box (box_2d, [ymin, xmin, ymax,
xmax] normalised to 0-1000) {box} on this frame: {label} ({kind}).
Scene, from an earlier pass over the video: {scene}
The producer chose this product for the spot: {product}.
Look at the frame and decide how this product naturally appears there, then write the edit prompt.
""" + PLACEMENT_RULES + """
Write one edit prompt: """ + PROMPT_STYLE


def write_prompt(out: Path, llm, shot_id: str, box: dict, label: str, kind: str, product: dict) -> str:
    """Gemini's edit prompt for a product the producer picked (Gemini's own picks come with theirs). Cached."""
    key = hashlib.sha1(json.dumps([shot_id, [round(box[k], 3) for k in ("x", "y", "w", "h")], label, kind, product], sort_keys=True).encode()).hexdigest()[:16]
    cache = out / "prompts" / f"{key}.json"
    if cache.is_file():
        return json.loads(cache.read_text())["prompt"]
    frame = out / "keyframes" / f"{shot_id}_mid.jpg"
    if not frame.is_file():
        raise FileNotFoundError(f"no keyframe for {shot_id}")
    scene = "unknown"
    scenes_file = out / "scenes.json"
    if scenes_file.is_file():
        s = next((x for x in json.loads(scenes_file.read_text()).get("scenes", []) if x.get("shotId") == shot_id), None)
        if s:
            scene = json.dumps({k: s.get(k) for k in ("scene", "people") if k in s}, ensure_ascii=False)
    what = f"{product.get('brand', '')} {product.get('name', '')}".strip() + (f" ({product['description']})" if product.get("description") else "") + f", category {product.get('category', '')}"
    prompt = WRITE_PROMPT.format(box=_box_2d(box), label=label, kind=kind or "other", scene=scene, product=what)
    g = _GPrompt.model_validate(llm.identify_box(frame, prompt, {"schema": _GPrompt, "thinking": "LOW"}))
    text = g.prompt.strip()
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"prompt": text, "product": product, "label": label}, ensure_ascii=False, indent=2))
    return text
