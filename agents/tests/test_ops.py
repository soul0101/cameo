"""Operator analytics: visit beacons, events from paid steps, the admin summary and the limit controls."""
import json

import pytest
from fastapi.testclient import TestClient

from cameo_agents import api, ops
from cameo_agents.limits import Limits

TOKEN = "s3cret-token"


@pytest.fixture()
def c(tmp_path, monkeypatch):
    root = tmp_path / "out"
    root.mkdir()
    monkeypatch.setattr(api, "OUT_ROOT", root)
    monkeypatch.setattr(api, "LIMITS", Limits(root / ".limits.json", 5.0, 3.0, 4.0))
    monkeypatch.setenv("CAMEO_ADMIN_TOKEN", TOKEN)
    sample = root / "up-sample01"
    sample.mkdir()
    (sample / "sample.json").write_text(json.dumps({"name": "Park walk", "versions": []}))
    return TestClient(api.app)


def admin(c, **kw):
    return c.get("/admin/summary", headers={"Authorization": f"Bearer {TOKEN}"}, **kw)


def test_admin_needs_the_token(c, monkeypatch):
    assert c.get("/admin/summary").status_code == 401
    assert c.get("/admin/summary", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert admin(c).status_code == 200
    monkeypatch.delenv("CAMEO_ADMIN_TOKEN")
    assert admin(c).status_code == 404  # off without a token


def test_visits_and_events_are_summarized(c):
    a = {"x-cameo-visitor": "browser-aaaa1111", "x-forwarded-for": "198.51.100.7"}
    b = {"x-cameo-visitor": "browser-bbbb2222", "x-forwarded-for": "198.51.100.8"}
    assert c.post("/ops/visit", json={"path": "/"}, headers=a).json() == {"ok": True}
    c.post("/ops/visit", json={"path": "/p/up-sample01/scenes", "episodeId": "up-sample01"}, headers=a)
    c.post("/ops/visit", json={"path": "/p/up-sample01/watch", "episodeId": "up-sample01"}, headers=b)
    c.post("/ops/visit", json={"path": "/admin"}, headers=b)  # the dashboard itself is not a visit
    ops.record("preview", "browser-aaaa1111", "up-sample01", cost=0.04)
    ops.record("preview", "browser-aaaa1111", "up-sample01", cached=True)
    ops.record("render_start", "browser-bbbb2222", "up-sample01", render="r1")
    ops.record("render_done", "server", "up-sample01", cost=0.29, owner="browser-bbbb2222", render="r1", passed=True)
    s = admin(c, params={"days": 1}).json()
    t = s["totals"]
    assert t["visitors"] == 2 and t["visits"] == 3 and t["images"] == 1 and t["imagesCached"] == 1
    assert t["renders"] == 1 and t["rendersPassed"] == 1 and t["spend"] == pytest.approx(0.33)
    assert s["samples"] == [{"id": "up-sample01", "name": "Park walk", "views": 2, "visitors": 2}]
    rows = {r["visitor"]: r for r in s["visitors"]}
    assert rows["browser-bbbb2222"]["renders"] == 1 and rows["browser-bbbb2222"]["spend"] == pytest.approx(0.29)
    assert rows["browser-aaaa1111"]["samples"] == ["Park walk"] and rows["browser-aaaa1111"]["net"].startswith("ip-")
    assert "198.51.100.7" not in (api.OUT_ROOT / ".ops" / "activity.jsonl").read_text()  # addresses are only stored hashed
    assert s["hourly"] and s["series"] and s["recent"][0]["kind"] == "render_done"


def test_limit_controls(c):
    lim = api.LIMITS
    lim.reserve("browser-x", "ip-x", "render", 2.0)
    lim.reserve("browser-x", "ip-x", "render", 0.9)
    h = {"Authorization": f"Bearer {TOKEN}"}
    snap = c.post("/admin/limits", json={"budget": 12.5, "visitorCap": 3.2}, headers=h).json()
    assert snap["budget"] == 12.5 and snap["visitorCap"] == 3.2 and snap["networkCap"] == 4.0 and snap["spent"] == 2.9
    assert snap["blocked"] == {"visitors": [], "nets": []}
    with pytest.raises(Exception):
        lim.reserve("browser-x", "ip-x", "render", 0.36)  # $2.90 + $0.36 would pass the browser's $3.20
    assert c.post("/admin/limits", json={}, headers=h).json()["blocked"] == {"visitors": ["browser-x"], "nets": []}
    assert Limits(api.OUT_ROOT / ".limits.json", 5.0, 3.0, 4.0).visitor_cap == 3.2  # kept across a restart
    snap = c.post("/admin/limits", json={"resetSpend": True, "resetVisitor": "browser-x", "resetNetwork": "ip-x"}, headers=h).json()
    assert snap["spent"] == 0 and snap["visitors"] == {} and snap["nets"] == {} and snap["blocked"]["visitors"] == []
    assert c.post("/admin/limits", json={"budget": -1}, headers=h).status_code == 400
    assert c.post("/admin/limits", json={"networkCap": "lots"}, headers=h).status_code == 400
    assert c.post("/admin/limits", json={"budget": 1}).status_code == 401
    assert admin(c).json()["limits"]["budget"] == 12.5


def test_test_alert_is_logged(c, capsys):
    h = {"Authorization": f"Bearer {TOKEN}"}
    assert c.post("/admin/test-alert").status_code == 401
    assert c.post("/admin/test-alert", headers=h).json() == {"ok": True}
    line = next(json.loads(x) for x in capsys.readouterr().out.splitlines() if "cameo_alert" in x)
    assert line["severity"] == "WARNING" and line["cameo_alert"] == "test" and line["message"].startswith("Cameo: Test alert")
    assert admin(c).json()["totals"]["alerts"] == 1


def test_context_actions_funnel_and_visitor_detail(c):
    a = {"x-cameo-visitor": "browser-cccc3333", "x-forwarded-for": "203.0.113.20"}
    ctx = {"country": "IN", "timezone": "Asia/Kolkata", "language": "en-IN", "browser": "Chrome", "os": "macOS", "device": "Desktop", "referrer": "devpost.com"}
    c.post("/ops/visit", json={"path": "/", "session": "s1", "entry": True, "context": ctx}, headers=a)
    c.post("/ops/visit", json={"path": "/p/up-sample01/scenes", "episodeId": "up-sample01", "session": "s1"}, headers=a)
    c.post("/ops/event", json={"action": "place_product", "episodeId": "up-sample01", "session": "s1", "props": {"product": "kora-in", "for": "IN"}}, headers=a)
    c.post("/ops/event", json={"action": "engaged", "session": "s1", "props": {"seconds": 42}}, headers=a)
    assert c.post("/ops/event", json={"action": "rm -rf", "props": {}}, headers=a).json() == {"ok": True}  # unknown actions are dropped
    s = admin(c, params={"days": 1}).json()
    assert s["totals"]["actions"] == 1 and s["totals"]["engagedSeconds"] == 42 and s["totals"]["sessions"] == 1
    assert s["actions"] == [{"action": "place_product", "count": 1}]
    assert s["audience"]["countries"] == [{"name": "IN", "visitors": 1}] and s["audience"]["referrers"] == [{"name": "devpost.com", "visitors": 1}]
    funnel = {f["step"]: f["visitors"] for f in s["funnel"]}
    assert funnel["landed"] == funnel["sample"] == funnel["scenes"] == funnel["tried"] == 1 and funnel["render"] == 0
    d = c.get("/admin/visitor/browser-cccc3333", headers={"Authorization": f"Bearer {TOKEN}"}).json()
    assert d["profile"]["country"] == "IN" and d["profile"]["seconds"] == 42 and d["profile"]["sections"] == ["landing", "scenes"]
    assert [e.get("action") or e["kind"] for e in d["timeline"]][:2] == ["engaged", "place_product"]
    assert d["spentToday"] == 0 and d["visitorCap"] == 3.0 and d["blocked"] is False
    assert c.get("/admin/visitor/browser-cccc3333").status_code == 401
    assert c.get("/admin/visitor/nobody-0000", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 404


def test_summary_counts_automated_browsers_apart():
    from cameo_agents.ops import summarize

    chrome = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/155.0 Safari/537.36"
    headless = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 HeadlessChrome/156.0 Safari/537.36"
    events = [
        {"t": 1.0, "kind": "visit", "visitor": "person-1", "net": "ip-a", "ua": chrome, "path": "/"},
        {"t": 2.0, "kind": "visit", "visitor": "person-2", "net": "ip-a", "ua": chrome, "path": "/"},
        {"t": 3.0, "kind": "visit", "visitor": "test-run", "net": "ip-a", "ua": headless, "path": "/"},
        {"t": 4.0, "kind": "upload", "visitor": "script", "net": "ip-b", "cost": 0.0},
    ]
    s = summarize(events, 0, 10.0, {})
    assert s["totals"]["visitors"] == 2 and s["totals"]["automated"] == 2 and s["totals"]["networks"] == 1
    assert s["totals"]["visits"] == 2 and s["totals"]["automatedVisits"] == 1 and s["totals"]["uploads"] == 1
    assert [v["visitor"] for v in s["visitors"] if v["automated"]] == ["script", "test-run"]
    assert s["funnel"][0]["visitors"] == 2
