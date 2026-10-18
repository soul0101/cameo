import json

from cameo_agents.catalog import parse_audiences, parse_catalog, to_products
from cameo_agents.pipeline import run


def test_offline_pipeline_end_to_end(ingested):
    out = ingested
    page, web = run(out, "mock")
    assert [s.shotId for s in page.scenes] == ["C01", "C02"]
    assert page.boxes and web["moments"] and web["placements"]
    assert [m["id"] for m in web["moments"]] == [f"M{i}" for i in range(1, len(web["moments"]) + 1)]
    assert (out / "scenes.json").exists() and json.loads((out / "web.json").read_text())["moments"]
    for stage in ("stage1", "stage2", "stage3"):
        assert (out / "cache" / "mock" / f"{stage}.json").exists()
    # second run is served from cache and gives the same result
    _, web2 = run(out, "mock")
    assert web2 == web


def test_offline_pipeline_with_browser_catalog(ingested):
    """Audience ids are free strings; suggestions are keyed by them and only use eligible catalog ids."""
    out = ingested
    aud = parse_audiences([{"id": "a-1", "name": "All", "kind": "region"}, {"id": "a-2", "name": "Sub", "kind": "segment", "basedOn": "a-1"}, {"id": "a-3", "name": "Other", "kind": "region"}])
    cat = parse_catalog([{"id": "x1", "brand": "B", "name": "Cup", "category": "drink", "url": "", "availableIn": ["a-1"]},
                         {"id": "x2", "brand": "C", "name": "Poster", "category": "art", "url": "", "availableIn": ["a-3"]}])
    products = to_products(cat, aud)
    page, web = run(out, "mock", products=products, regions=[a.id for a in aud])
    assert page.regions == ["a-1", "a-2", "a-3"]
    allowed = {"a-1": {"x1"}, "a-2": {"x1"}, "a-3": {"x2"}}
    assert web["suggestions"]
    for box, by_aud in web["suggestions"].items():
        for a, picks in by_aud.items():
            assert {p["productId"] for p in picks} <= allowed[a]
