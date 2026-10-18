import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from cameo_agents import events


@pytest.fixture
def client(tmp_path):
    (tmp_path / "ep-1").mkdir()
    (tmp_path / "ep-1" / "ingest.json").write_text(json.dumps({"duration": 5.5}))
    events.configure(lambda: tmp_path)
    app = FastAPI()
    app.include_router(events.router)
    yield TestClient(app)
    events.configure(events._default_root)


def ev(**kw):
    base = {"episodeId": "ep-1", "sessionId": "s1", "type": "impression", "t": 1.2}
    base.update(kw)
    return base


def test_valid_post_appends(client, tmp_path):
    r = client.post("/events", json=ev(productId="p1", junk="x"))
    assert r.status_code == 200 and r.json() == {"ok": True}
    client.post("/events", json=ev(type="shop_click", shotId=None))
    lines = (tmp_path / "ep-1" / "events.jsonl").read_text().splitlines()
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["productId"] == "p1" and "at" in first and "junk" not in first


@pytest.mark.parametrize(
    "patch",
    [
        {"type": "nope"},
        {"t": -1},
        {"t": True},
        {"t": 90000},
        {"t": "1"},
        {"sessionId": ""},
        {"sessionId": "x" * 129},
        {"productId": 5},
        {"boxId": "y" * 129},
    ],
)
def test_validation_400(client, patch):
    assert client.post("/events", json=ev(**patch)).status_code == 400


def test_missing_session(client):
    body = ev()
    del body["sessionId"]
    assert client.post("/events", json=body).status_code == 400


def test_non_object_and_bad_json(client):
    assert client.post("/events", json=[1]).status_code == 400
    assert client.post("/events", content=b"{nope").status_code == 400


def test_unknown_episode_and_bad_id(client):
    assert client.post("/events", json=ev(episodeId="ep-2")).status_code == 404
    assert client.post("/events", json=ev(episodeId="../x")).status_code == 400
    assert client.post("/events", json=ev(episodeId="EP")).status_code == 400


def test_oversized(client):
    assert client.post("/events", json=ev(shotId="a" * 5000)).status_code == 413


def test_analytics_empty(client):
    d = client.get("/episodes/ep-1/analytics").json()
    assert d["totals"] == {"impressions": 0, "shop_clicks": 0, "product_views": 0, "product_saves": 0}
    assert d["byProduct"] == [] and d["byAudience"] == []
    assert [s["t"] for s in d["series"]] == [0, 1, 2, 3, 4, 5]
    assert all(s["impressions"] == 0 and s["shop_clicks"] == 0 for s in d["series"])


def test_analytics_errors(client):
    assert client.get("/episodes/nope/analytics").status_code == 404
    assert client.get("/episodes/BAD_ID/analytics").status_code == 400


def test_analytics_aggregation(client, tmp_path):
    client.post("/events", json=ev(t=0.5, productId="b", audienceId="a2"))
    client.post("/events", json=ev(t=0.9, productId="a", audienceId="a1"))
    client.post("/events", json=ev(type="shop_click", t=2.0, productId="a"))
    client.post("/events", json=ev(type="product_view", t=3, productId="a"))
    client.post("/events", json=ev(type="product_save", t=3, productId="b", audienceId="a1"))
    with open(tmp_path / "ep-1" / "events.jsonl", "a") as f:
        f.write("not json\n{\"type\":\"bogus\",\"t\":1}\n")
    d = client.get("/episodes/ep-1/analytics").json()
    assert d["totals"] == {"impressions": 2, "shop_clicks": 1, "product_views": 1, "product_saves": 1}
    assert [p["productId"] for p in d["byProduct"]] == ["a", "b"]
    a = d["byProduct"][0]
    assert (a["impressions"], a["shop_clicks"], a["product_views"], a["product_saves"]) == (1, 1, 1, 0)
    assert [x["audienceId"] for x in d["byAudience"]] == ["a1", "a2"]
    assert d["byAudience"][0]["impressions"] == 1 and d["byAudience"][0]["product_saves"] == 1
    assert len(d["series"]) == 6
    assert d["series"][0]["impressions"] == 2
    assert d["series"][2]["shop_clicks"] == 1
    assert d["series"][5] == {"t": 5, "impressions": 0, "shop_clicks": 0}


def test_series_extends_to_late_event(client):
    client.post("/events", json=ev(t=8.1))
    d = client.get("/episodes/ep-1/analytics").json()
    assert len(d["series"]) == 9 and d["series"][8]["impressions"] == 1


def test_analytics_counts_only_the_asking_browser(client):
    a, b = {"X-Cameo-Visitor": "visitor-aaaa"}, {"X-Cameo-Visitor": "visitor-bbbb"}
    client.post("/events", json=ev(productId="p1"), headers=a)
    client.post("/events", json=ev(productId="p1", type="shop_click"), headers=a)
    client.post("/events", json=ev(productId="p2"), headers=b)
    mine = client.get("/episodes/ep-1/analytics", headers=a).json()
    theirs = client.get("/episodes/ep-1/analytics", headers=b).json()
    assert mine["totals"]["impressions"] == 1 and mine["totals"]["shop_clicks"] == 1
    assert [p["productId"] for p in mine["byProduct"]] == ["p1"]
    assert theirs["totals"]["impressions"] == 1 and [p["productId"] for p in theirs["byProduct"]] == ["p2"]
    assert client.get("/episodes/ep-1/analytics", headers={"X-Cameo-Visitor": "visitor-cccc"}).json()["totals"]["impressions"] == 0
