"""Catalog/audience eligibility, Cloud Vision parsing + caching (mock), stage-3 parsing keyed by audience."""
import json
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

from cameo_agents import vision
from cameo_agents.catalog import CatalogError, catalog_hash, eligible, lineage, parse_audiences, parse_catalog, to_products
from cameo_agents.ingest import load_ingest
from cameo_agents.models import GeminiLLM
from cameo_agents.schemas import Box, NormBox, SceneUnderstanding

AUD = parse_audiences([{"id": "root", "name": "R", "kind": "k"}, {"id": "mid", "name": "M", "kind": "k", "basedOn": "root"},
                       {"id": "leaf", "name": "L", "kind": "k", "basedOn": "mid"}, {"id": "solo", "name": "S", "kind": "k"}])


def prod(i, avail):
    return parse_catalog([{"id": i, "brand": "B", "name": "N", "category": "c", "url": "", "availableIn": avail}])[0]


def test_eligibility_follows_based_on_recursively():
    assert lineage("leaf", AUD) == ["leaf", "mid", "root"]
    p = prod("p", ["root"])
    assert all(eligible(p, a, AUD) for a in ("root", "mid", "leaf")) and not eligible(p, "solo", AUD)
    assert eligible(prod("q", "all"), "solo", AUD)
    assert not eligible(prod("r", ["leaf"]), "mid", AUD)  # inheritance goes down, not up
    assert not eligible(prod("s", []), "root", AUD)


def test_based_on_cycles_and_unknown_parents_terminate():
    aud = parse_audiences([{"id": "a", "name": "", "kind": "", "basedOn": "b"}, {"id": "b", "name": "", "kind": "", "basedOn": "a"},
                           {"id": "c", "name": "", "kind": "", "basedOn": "ghost"}])
    assert lineage("a", aud) == ["a", "b"] and lineage("c", aud) == ["c", "ghost"]
    assert eligible(prod("p", ["b"]), "a", aud)


def test_to_products_one_row_per_eligible_audience():
    cat = [prod("p", ["root"]), prod("q", "all")]
    rows = [(p.id, p.region) for p in to_products(cat, AUD)]
    assert rows == [("p", "root"), ("q", "root"), ("p", "mid"), ("q", "mid"), ("p", "leaf"), ("q", "leaf"), ("q", "solo")]


def test_parse_errors_and_hash():
    with pytest.raises(CatalogError):
        parse_audiences([])
    with pytest.raises(CatalogError):
        parse_audiences([{"id": "a", "name": "", "kind": ""}] * 2)
    with pytest.raises(CatalogError):
        parse_catalog([{"id": "x"}])
    with pytest.raises(CatalogError):
        parse_catalog([{"id": "x", "brand": "", "name": "", "category": "", "availableIn": "some"}])
    a, b = [prod("p", "all"), prod("q", ["root"])], [prod("q", ["root"]), prod("p", "all")]
    assert catalog_hash(a, AUD) == catalog_hash(b, AUD) != catalog_hash(a[:1], AUD)


def test_parse_annotations_clamps_and_sorts():
    v = lambda x, y: NS(x=x, y=y)
    anns = [NS(name="Cup", score=0.5, bounding_poly=NS(normalized_vertices=[v(0.1, 0.2), v(0.3, 0.2), v(0.3, 0.6), v(0.1, 0.6)])),
            NS(name="Table", score=0.9, bounding_poly=NS(normalized_vertices=[v(-0.1, 0.5), v(1.2, 0.5), v(1.2, 1.0), v(-0.1, 1.0)])),
            NS(name="Empty", score=0.9, bounding_poly=NS(normalized_vertices=[]))]
    out = vision.parse_annotations(anns)
    assert [o["name"] for o in out] == ["Table", "Cup"]
    assert out[0]["box"] == {"x": 0.0, "y": 0.5, "w": 1.0, "h": 0.5}
    assert out[1]["box"] == {"x": 0.1, "y": 0.2, "w": 0.2, "h": 0.4}


def test_near_box_and_describe():
    objs = [{"name": "Far", "score": 0.9, "box": {"x": 0.8, "y": 0.8, "w": 0.1, "h": 0.1}}, {"name": "Cup", "score": 0.7, "box": {"x": 0.2, "y": 0.2, "w": 0.1, "h": 0.1}}]
    assert [o["name"] for o in vision.near_box(objs, {"x": 0.25, "y": 0.25, "w": 0.1, "h": 0.1})] == ["Cup"]
    assert vision.describe([]) == "none found" and vision.describe(objs[1:]).startswith("Cup 0.70 at [x 0.20")


class CountingVision(vision.MockVision):
    def __init__(self):
        self.n = 0

    def localize(self, image):
        assert image.is_file()
        self.n += 1
        return super().localize(image)


def test_run_vision_caches_per_keyframe(ingested):
    out = ingested
    ing = load_ingest(out)
    n = sum(len(s.keyframes) for s in ing.shots)
    assert vision.estimate(ing, out) == (n, round(n * vision.PRICE_PER_IMAGE, 4))
    v = CountingVision()
    seen = []
    r = vision.run_vision(ing, out, v, on_progress=lambda m, f: seen.append(f))
    assert v.n == n and r["calls"] == n and r["visionFrames"] == n and r["objects"] == n and r["cost"] == 0
    assert seen and max(seen) == 1.0
    assert json.loads((out / "cache" / "vision" / "C01_mid.json").read_text())["objects"][0]["name"] == "Cup"
    r2 = vision.run_vision(ing, out, v)
    assert v.n == n and r2["calls"] == 0 and vision.estimate(ing, out) == (0, 0.0)
    assert vision.shot_objects(out, "C01")[0]["name"] == "Cup"


def test_get_vision_backends(monkeypatch):
    monkeypatch.setenv("CAMEO_VISION", "mock")
    assert isinstance(vision.get_vision(), vision.MockVision)
    assert vision.get_vision("off").localize(Path("x")) == []
    with pytest.raises(ValueError):
        vision.get_vision("nope")


def test_stage2_prompt_carries_vision_objects(tmp_path):
    from cameo_agents.schemas import Keyframe, Surface

    img = tmp_path / "f.jpg"
    img.write_bytes(b"\xff\xd8\xff")
    llm = GeminiLLM(client=object(), project="p")
    req = llm.stage2_request(Keyframe(shotId="C01", pos="mid", t=1.0, path="f.jpg"), img, [Surface(label="cup", kind="table", timeVisible=1)],
                             [{"name": "Mug", "score": 0.8, "box": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}}])
    assert "Mug 0.80 at [x 0.10" in req.prompt


def test_parse_match_keys_products_by_audience():
    """The same catalog id may serve several audiences; a pick is valid only for audiences it is eligible for."""
    sc = SceneUnderstanding.model_validate({"shotId": "C01", "tIn": 0, "tOut": 8, "scene": {"type": "café", "mood": "warm"}})
    b = Box(id="C01-b1", label="cup", kind="table", shotId="C01", box=NormBox(x=0.1, y=0.1, w=0.3, h=0.3), t=4)
    aud = parse_audiences([{"id": "u1", "name": "", "kind": ""}, {"id": "u2", "name": "", "kind": ""}])
    cat = to_products([prod("both", "all"), prod("only1", ["u1"])], aud)
    text = json.dumps({"boxNotes": [], "matches": [
        {"boxId": "C01-b1", "regionId": "u1", "suggestions": [{"productId": "only1", "why": "w"}, {"productId": "both", "why": "w"}], "defaultPrompt": "x"},
        {"boxId": "C01-b1", "regionId": "u2", "suggestions": [{"productId": "only1", "why": "w"}, {"productId": "both", "why": "w"}], "defaultPrompt": "y"}]})
    out, issues = GeminiLLM.parse_match(text, [sc], [b], cat, ["u1", "u2"])
    picks = {s.region: [p.productId for p in s.suggestions] for s in out[0].suggestions}
    assert picks == {"u1": ["only1", "both"], "u2": ["both"]}
    assert any("only1 not in that audience" in i for i in issues)


def test_match_prompt_names_audiences_not_regions():
    sc = SceneUnderstanding.model_validate({"shotId": "C01", "tIn": 0, "tOut": 8, "scene": {"type": "café", "mood": "warm"}})
    b = Box(id="C01-b1", label="cup", kind="table", shotId="C01", box=NormBox(x=0.1, y=0.1, w=0.3, h=0.3), t=4)
    llm = GeminiLLM(client=object(), project="p")
    llm.audience_text = "- aud-9: Night owls (segment)"
    aud = parse_audiences([{"id": "aud-9", "name": "Night owls", "kind": "segment"}])
    req = llm.match_request([sc], [b], to_products([prod("x", "all")], aud), __import__("cameo_agents.schemas", fromlist=["RuleSet"]).RuleSet(), ["aud-9"])
    assert "aud-9: Night owls (segment)" in req.prompt and "[aud-9]" in req.prompt
    for word in ("region", " IN", " JP"):
        assert word not in req.prompt.split("CATALOG")[0].replace("regionId", "")
