"""API tests on a generated clip with the offline LLM and Vision stand-ins (no network): upload -> needs_confirmation ->
cancel / confirm, detected.json, re-match, identify, rerun, delete."""
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cameo_agents import api
from cameo_agents.limits import Limits
from tests.conftest import make_clip

AUDIENCES = [{"id": "aud-base", "name": "Everyone", "kind": "region"}, {"id": "aud-kids", "name": "Families", "kind": "segment", "basedOn": "aud-base"},
             {"id": "aud-x", "name": "Gamers", "kind": "interest"}]
CATALOG = [
    {"id": "p-cola", "brand": "Fizz", "name": "Cola can", "category": "beverage/soda", "url": "https://example.com/cola", "availableIn": "all"},
    {"id": "p-tea", "brand": "Leaf", "name": "Green tea cup", "category": "beverage/tea", "url": "https://example.com/tea", "availableIn": ["aud-base"]},
    {"id": "p-pad", "brand": "Pad", "name": "Game pad", "category": "electronics", "url": "https://example.com/pad", "availableIn": ["aud-x"], "description": "black"},
]
BODY = {"catalog": CATALOG, "audiences": AUDIENCES}


@pytest.fixture()
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(api, "LIMITS", Limits(tmp_path / "limits.json", 0, 0, 0))
    monkeypatch.setenv("CAMEO_VISION", "mock")
    api.JOBS.clear()
    return TestClient(api.app)


def events(client, job_id):
    out = []
    with client.stream("GET", f"/jobs/{job_id}/events") as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        for line in r.iter_lines():
            if line.startswith("data: "):
                out.append(json.loads(line[6:]))
    return out


def test_health_and_cors(client):
    assert client.get("/health").json() == {"ok": True}
    r = client.options("/episodes", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"})
    assert r.headers["access-control-allow-origin"] == "http://localhost:5173"


def clip(tmp_path: Path) -> Path:
    p = tmp_path / "clip.mp4"
    if not p.exists():
        make_clip(p)
    return p


@pytest.fixture()
def upload_client(client, tmp_path, monkeypatch):
    monkeypatch.setattr(api, "OUT_ROOT", tmp_path / "out")
    (tmp_path / "out").mkdir()
    return client


def upload(client, tmp_path):
    with clip(tmp_path).open("rb") as f:
        r = client.post("/episodes", files={"file": ("clip.mp4", f, "video/mp4")})
    assert r.status_code == 200, r.text
    return r.json()


def wait_state(client, job_id, state, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = client.get(f"/jobs/{job_id}").json()
        if s["state"] == state:
            return s
        assert s["state"] not in ("failed",), s
        time.sleep(0.1)
    raise AssertionError(f"job never reached {state}")


def test_upload_reaches_needs_confirmation_then_cancel(upload_client, tmp_path):
    j = upload(upload_client, tmp_path)
    assert set(j) == {"jobId", "episodeId"} and j["episodeId"].startswith("up-") and len(j["episodeId"]) == 19
    assert (api.OUT_ROOT / j["episodeId"] / "source.mp4").exists()
    wait_state(upload_client, j["jobId"], "awaiting_confirmation")
    evs = list(api.JOBS[j["jobId"]].events)
    assert [e["state"] for e in evs if e["stage"] == "ingest"][0] == "running"
    done = next(e for e in evs if e["stage"] == "ingest" and e["state"] == "done")
    assert done["counts"]["shots"] >= 1 and done["counts"]["keyframes"] == 3 * done["counts"]["shots"]
    nc = evs[-1]
    # Gemini: stage 1 + stage 3 + one stage-2 call per keyframe; Cloud Vision: one request per keyframe
    assert nc["stage"] == "understand" and nc["state"] == "needs_confirmation" and nc["calls"] == 2 + 2 * done["counts"]["keyframes"]
    assert nc["message"].startswith("Run detection on Vertex AI and Cloud Vision · ~$") and round(nc["cost"], 2) == nc["cost"]
    assert upload_client.post(f"/jobs/{j['jobId']}/cancel").status_code == 200
    evs = events(upload_client, j["jobId"])
    assert evs[-1]["stage"] == "job" and evs[-1]["state"] == "cancelled"
    assert upload_client.post(f"/jobs/{j['jobId']}/confirm").status_code == 409


def test_confirm_with_mock_llm_completes(upload_client, tmp_path, monkeypatch):
    monkeypatch.setenv("CAMEO_API_LLM", "mock")
    j = upload(upload_client, tmp_path)
    wait_state(upload_client, j["jobId"], "awaiting_confirmation")
    assert upload_client.post(f"/jobs/{j['jobId']}/confirm").status_code == 400  # an upload needs the catalog
    assert upload_client.post(f"/jobs/{j['jobId']}/confirm", json={"catalog": [], "audiences": AUDIENCES}).status_code == 400
    assert upload_client.post(f"/jobs/{j['jobId']}/confirm", json=BODY).status_code == 200
    evs = events(upload_client, j["jobId"])
    assert evs[-1]["state"] == "complete", evs[-3:]
    stages = [e["stage"] for e in evs if e["state"] == "done"]
    assert stages == ["ingest", "vision", "understand", "localise", "match"]
    vis = next(e for e in evs if e["stage"] == "vision" and e["state"] == "done")
    assert vis["counts"]["visionFrames"] == vis["calls"] > 0 and vis["cost"] == 0  # mock vision costs nothing
    out = api.OUT_ROOT / j["episodeId"]
    assert len(list((out / "cache" / "vision").glob("*.json"))) == vis["calls"]
    d = upload_client.get(f"/episodes/{j['episodeId']}/detected.json").json()
    assert d["audiences"] == ["aud-base", "aud-kids", "aud-x"]
    assert all(s["visionObjects"][0]["name"] == "Cup" for s in d["episode"]["shots"])


def test_cors_any_dev_port(client):
    r = client.get("/health", headers={"Origin": "http://localhost:5200"})
    assert r.headers["access-control-allow-origin"] == "http://localhost:5200"
    r = client.get("/health", headers={"Origin": "http://evil.example.com"})
    assert "access-control-allow-origin" not in r.headers


def test_rerun_unknown_404(upload_client):
    assert upload_client.post("/episodes/up-deadbeef/rerun").status_code == 404
    assert upload_client.post("/episodes/BAD_ID/rerun").status_code == 400


def test_rerun_upload_clears_caches_and_redetects(upload_client, tmp_path, monkeypatch):
    monkeypatch.setenv("CAMEO_API_LLM", "mock")
    j = upload(upload_client, tmp_path)
    wait_state(upload_client, j["jobId"], "awaiting_confirmation")
    upload_client.post(f"/jobs/{j['jobId']}/confirm", json=BODY)
    assert events(upload_client, j["jobId"])[-1]["state"] == "complete"
    out = api.OUT_ROOT / j["episodeId"]
    cache = out / "cache" / "mock"
    assert (cache / "stage1.json").exists()
    (cache / "keep.txt").write_text("x")
    marker = out / "ingest.json"
    mtime = marker.stat().st_mtime_ns
    # cancel on a rerun deletes nothing
    r0 = upload_client.post(f"/episodes/{j['episodeId']}/rerun").json()
    wait_state(upload_client, r0["jobId"], "awaiting_confirmation")
    upload_client.post(f"/jobs/{r0['jobId']}/cancel")
    assert (cache / "stage1.json").exists()
    # real rerun
    r = upload_client.post(f"/episodes/{j['episodeId']}/rerun").json()
    assert r["episodeId"] == j["episodeId"]
    wait_state(upload_client, r["jobId"], "awaiting_confirmation")
    assert marker.stat().st_mtime_ns != mtime  # re-extract re-cuts the shots from the source
    evs = list(api.JOBS[r["jobId"]].events)
    assert next(e for e in evs if e["stage"] == "ingest" and e["state"] == "done")["counts"]["shots"] >= 1
    assert evs[-1]["state"] == "needs_confirmation"
    assert (cache / "stage1.json").exists()  # nothing cleared before confirm
    stamp = (cache / "stage1.json").stat().st_mtime_ns
    assert upload_client.post(f"/jobs/{r['jobId']}/confirm", json=BODY).status_code == 200
    evs = events(upload_client, r["jobId"])
    assert evs[-1]["state"] == "complete", evs[-3:]
    assert [e["stage"] for e in evs if e["state"] == "done" and e["stage"] != "job"] == ["ingest", "vision", "understand", "localise", "match"]
    assert (cache / "stage1.json").stat().st_mtime_ns != stamp  # regenerated
    assert (cache / "keep.txt").exists()


def test_confirm_config_error_fails_visibly(upload_client, tmp_path, monkeypatch):
    """A missing Vertex config raises SystemExit inside the worker thread: the job must fail, not hang."""
    def boom(name, **_):
        raise SystemExit("--llm gemini runs on Vertex AI: set GOOGLE_GENAI_USE_VERTEXAI=true")
    monkeypatch.setattr(api, "get_llm", boom)
    j = upload(upload_client, tmp_path)
    wait_state(upload_client, j["jobId"], "awaiting_confirmation")
    assert upload_client.post(f"/jobs/{j['jobId']}/confirm", json=BODY).status_code == 200
    evs = events(upload_client, j["jobId"])
    assert evs[-1]["stage"] == "job" and evs[-1]["state"] == "failed" and "GOOGLE_GENAI_USE_VERTEXAI" in evs[-1]["message"]


def test_load_env_keeps_shell_values(tmp_path, monkeypatch):
    p = tmp_path / ".env"
    p.write_text("# c\nCAMEO_T_A=1\nexport CAMEO_T_B='two'\nCAMEO_T_C=file\n")
    monkeypatch.setenv("CAMEO_T_C", "shell")
    monkeypatch.delenv("CAMEO_T_A", raising=False)
    monkeypatch.delenv("CAMEO_T_B", raising=False)
    api.load_env(p)
    import os
    assert os.environ["CAMEO_T_A"] == "1" and os.environ["CAMEO_T_B"] == "two" and os.environ["CAMEO_T_C"] == "shell"
    monkeypatch.delenv("CAMEO_T_A"); monkeypatch.delenv("CAMEO_T_B")


def test_cors_origins_env_parsing():
    assert api.cors_origins(" https://a.web.app/, https://b.example.com ,,") == ["https://a.web.app", "https://b.example.com"]
    assert api.cors_origins(None) == []


def test_events_router_mounted(upload_client):
    (api.OUT_ROOT / "up-deadbeef").mkdir()
    assert upload_client.post("/events", json={"episodeId": "up-deadbeef", "sessionId": "s", "type": "nope", "t": 1}).status_code == 400
    assert upload_client.get("/episodes/nope-nope/analytics").status_code == 404


def detected_upload(upload_client, tmp_path):
    j = upload(upload_client, tmp_path)
    wait_state(upload_client, j["jobId"], "awaiting_confirmation")
    assert upload_client.post(f"/jobs/{j['jobId']}/confirm", json=BODY).status_code == 200
    assert events(upload_client, j["jobId"])[-1]["state"] == "complete"
    return j["episodeId"]


def test_match_is_cost_gated_then_rewrites_suggestions(upload_client, tmp_path, monkeypatch):
    monkeypatch.setenv("CAMEO_API_LLM", "mock")
    assert upload_client.post("/episodes/up-deadbeef/match", json=BODY).status_code == 404
    eid = detected_upload(upload_client, tmp_path)
    assert upload_client.post(f"/episodes/{eid}/match", json={"catalog": CATALOG}).status_code == 400
    assert upload_client.post(f"/episodes/{eid}/match", json={"catalog": CATALOG, "audiences": [{"id": "a"}]}).status_code == 400
    before = upload_client.get(f"/episodes/{eid}/detected.json").json()
    assert before["matchId"] is None

    new_aud = [{"id": "zz-1", "name": "Night owls", "kind": "segment"}, {"id": "zz-2", "name": "Night owls, kids", "kind": "segment", "basedOn": "zz-1"}]
    new_cat = [{"id": "q-lamp", "brand": "Glow", "name": "Desk lamp", "category": "home", "url": "", "availableIn": ["zz-1"]},
               {"id": "q-mug", "brand": "Mugs", "name": "Mug", "category": "home/kitchen", "url": "", "availableIn": "all"}]
    r = upload_client.post(f"/episodes/{eid}/match", json={"catalog": new_cat, "audiences": new_aud})
    assert r.status_code == 200 and set(r.json()) == {"jobId"}
    jid = r.json()["jobId"]
    job = api.JOBS[jid]
    assert job.state == "awaiting_confirmation"
    nc = job.events[-1]
    assert nc["stage"] == "match" and nc["state"] == "needs_confirmation" and nc["calls"] == 1 and nc["cost"] > 0
    assert upload_client.get(f"/episodes/{eid}/detected.json").json()["matchId"] is None  # nothing ran yet
    assert upload_client.post(f"/jobs/{jid}/confirm").status_code == 200  # the match job already holds its catalog
    evs = events(upload_client, jid)
    assert evs[-1]["state"] == "complete", evs[-3:]
    assert [e["stage"] for e in evs if e["state"] == "done"] == ["match"]
    mid = evs[-1]["matchId"]
    assert upload_client.get(f"/episodes/{eid}/detected.json").json()["matchId"] is None  # default stays the original run
    after = upload_client.get(f"/episodes/{eid}/detected.json?match={mid}").json()
    assert after["matchId"] == mid and after["audiences"] == ["zz-1", "zz-2"]
    sugs = [b["suggestions"] for b in after["boxes"] if b["suggestions"]]
    assert sugs, after["boxes"]
    for s in sugs:
        assert set(s) <= {"zz-1", "zz-2"}
        for aud, picks in s.items():
            assert {p["productId"] for p in picks} <= {"q-lamp", "q-mug"}  # basedOn: zz-2 inherits q-lamp
    # the original run is still reachable, and a match id must exist
    orig = upload_client.get(f"/episodes/{eid}/detected.json?match=").json()
    assert orig["matchId"] is None and orig["audiences"] == ["aud-base", "aud-kids", "aud-x"]
    assert upload_client.get(f"/episodes/{eid}/detected.json?match={mid}").json()["matchId"] == mid
    # confirming twice is refused; a new detection run makes the original output current again
    assert upload_client.post(f"/jobs/{jid}/confirm").status_code == 409


def test_match_needs_detection_first(upload_client, tmp_path, monkeypatch):
    monkeypatch.setenv("CAMEO_API_LLM", "mock")
    j = upload(upload_client, tmp_path)
    wait_state(upload_client, j["jobId"], "awaiting_confirmation")
    assert upload_client.post(f"/episodes/{j['episodeId']}/match", json=BODY).status_code == 409


def test_match_cancel(upload_client, tmp_path, monkeypatch):
    monkeypatch.setenv("CAMEO_API_LLM", "mock")
    eid = detected_upload(upload_client, tmp_path)
    jid = upload_client.post(f"/episodes/{eid}/match", json=BODY).json()["jobId"]
    assert upload_client.post(f"/jobs/{jid}/cancel").status_code == 200
    assert upload_client.post(f"/jobs/{jid}/confirm").status_code == 409
    assert not (api.OUT_ROOT / eid / "match").exists()


@pytest.fixture()
def detected(upload_client, tmp_path, monkeypatch):
    """A detected upload (offline stand-ins): (client, episode id)."""
    monkeypatch.setenv("CAMEO_API_LLM", "mock")
    monkeypatch.setattr(api, "_IDENTIFY_LLM", None)
    return upload_client, detected_upload(upload_client, tmp_path)


def test_detected_json_and_episode_info(detected):
    c, eid = detected
    d = c.get(f"/episodes/{eid}/detected.json").json()
    ep = d["episode"]
    assert ep["id"] == eid == d["episodeId"] and ep["width"] > 0 and ep["fps"] > 0 and ep["duration"] > 0
    s0 = ep["shots"][0]
    assert s0["shotId"] == "C01" and s0["index"] == 0
    assert [k["pos"] for k in s0["keyframes"]] == ["start", "mid", "end"]
    assert [k["name"] for k in s0["keyframes"]] == ["C01_start", "C01_mid", "C01_end"]
    info = c.get(f"/episodes/{eid}").json()
    assert info == {"episodeId": eid, "sample": False, "hasDetected": True, "duration": info["duration"], "shots": len(ep["shots"])}
    assert c.get("/episodes/nope-nope").status_code == 404
    assert c.get("/episodes/BAD_ID").status_code == 400


def test_path_validation_and_404(detected):
    c, eid = detected
    assert c.get("/episodes/nope/detected.json").status_code == 404
    assert c.get("/episodes/BAD_ID/detected.json").status_code == 400
    assert c.get(f"/episodes/{eid}/media/keyframes/..%2Fingest.json").status_code in (400, 404)
    assert c.get(f"/episodes/{eid}/media/keyframes/x.png").status_code == 400
    assert c.get(f"/episodes/{eid}/media/keyframes/C01_mid.jpg").status_code == 200
    r = c.get(f"/episodes/{eid}/media/proxy", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206 and len(r.content) == 100
    assert c.post("/episodes", json={"sample": "other"}).status_code == 400
    assert c.post("/jobs/zzz/confirm").status_code == 404
    assert c.get(f"/episodes/{eid}/detected.json?match=abcdefabcdef").status_code == 404
    assert c.get(f"/episodes/{eid}/detected.json?match=../x").status_code == 404


def test_identify_picks_prompts_and_vision(detected):
    c, eid = detected
    body = {"shotId": "C01", "box": {"x": 0.4, "y": 0.4, "w": 0.3, "h": 0.3}, **BODY}
    r = c.post(f"/episodes/{eid}/identify", json=body)
    assert r.status_code == 200, r.text
    d = r.json()
    assert set(d) == {"label", "kind", "edit", "why", "picks", "prompts", "vision", "box"}
    assert set(d["picks"]) == set(d["prompts"]) == {"aud-base", "aud-kids", "aud-x"}
    ids = lambda a: [p["productId"] for p in d["picks"][a]]
    assert ids("aud-base") == ["p-cola", "p-tea"]
    assert ids("aud-kids") == ["p-cola", "p-tea"]  # basedOn aud-base
    assert ids("aud-x") == ["p-cola", "p-pad"]
    assert d["vision"]["objects"] and d["label"] == d["vision"]["objects"][0]
    assert all(d["prompts"][a] for a in d["picks"])
    # cached: same answer for the same request; another catalog is another cache entry
    assert len(list((api.OUT_ROOT / eid / "identify").glob("*.json"))) == 1
    assert c.post(f"/episodes/{eid}/identify", json=body).json() == d
    d2 = c.post(f"/episodes/{eid}/identify", json={**body, "catalog": CATALOG[:1]}).json()
    assert [p["productId"] for p in d2["picks"]["aud-x"]] == ["p-cola"]
    assert len(list((api.OUT_ROOT / eid / "identify").glob("*.json"))) == 2


def test_identify_validation(detected):
    c, eid = detected
    ok = {"shotId": "C01", "box": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}, **BODY}
    assert c.post(f"/episodes/{eid}/identify", json={**ok, "audiences": ["IN"]}).status_code == 400
    assert c.post(f"/episodes/{eid}/identify", json={**ok, "catalog": None}).status_code == 400
    assert c.post(f"/episodes/{eid}/identify", json={**ok, "box": {"x": 2, "y": 0, "w": 1, "h": 1}}).status_code == 400
    assert c.post(f"/episodes/{eid}/identify", json={**ok, "shotId": "../x"}).status_code == 400
    assert c.post(f"/episodes/{eid}/identify", json={**ok, "shotId": "C99"}).status_code == 404
    assert c.post("/episodes/nope-nope/identify", json=ok).status_code == 404


def test_match_writes_a_match_dir_and_keeps_the_original(detected):
    c, eid = detected
    r = c.post(f"/episodes/{eid}/match", json=BODY).json()
    assert c.post(f"/jobs/{r['jobId']}/confirm", json=BODY).status_code == 200
    evs = events(c, r["jobId"])
    assert evs[-1]["state"] == "complete", evs[-3:]
    out = api.OUT_ROOT / eid
    mid = (out / "match" / "active").read_text()
    assert mid == evs[-1]["matchId"] and (out / "match" / mid / "web.json").is_file()
    assert (out / "cache" / "mock" / f"stage3-{mid}.json").is_file()
    assert c.get(f"/episodes/{eid}/detected.json").json()["matchId"] is None
    d = c.get(f"/episodes/{eid}/detected.json?match={mid}").json()
    assert d["matchId"] == mid and d["audiences"] == ["aud-base", "aud-kids", "aud-x"]


def test_upload_over_the_limit_is_refused_then_trimmed(upload_client, tmp_path, monkeypatch):
    monkeypatch.setattr(api, "MAX_SECONDS", 2.0)  # the 3 s clip is over the limit
    with clip(tmp_path).open("rb") as f:
        r = upload_client.post("/episodes", files={"file": ("clip.mp4", f, "video/mp4")})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "too_long" and r.json()["detail"]["limit"] == 2.0
    assert not [p for p in api.OUT_ROOT.iterdir() if p.name.startswith("up-")]  # nothing kept
    with clip(tmp_path).open("rb") as f:
        r = upload_client.post("/episodes", files={"file": ("clip.mp4", f, "video/mp4")}, data={"trim": "1"})
    assert r.status_code == 200, r.text
    j = r.json()
    wait_state(upload_client, j["jobId"], "awaiting_confirmation")
    ing = json.loads((api.OUT_ROOT / j["episodeId"] / "ingest.json").read_text())
    assert abs(ing["duration"] - 2.0) < 0.15
    assert any("first 2 s" in e["message"] for e in api.JOBS[j["jobId"]].events if e["stage"] == "ingest")
    upload_client.post(f"/jobs/{j['jobId']}/cancel")


def test_delete_episode_removes_its_files(upload_client, tmp_path):
    j = upload(upload_client, tmp_path)
    wait_state(upload_client, j["jobId"], "awaiting_confirmation")
    r = upload_client.delete(f"/episodes/{j['episodeId']}")
    assert r.status_code == 200 and r.json() == {"ok": True, "deleted": True}
    assert not (api.OUT_ROOT / j["episodeId"]).exists()
    assert upload_client.get(f"/jobs/{j['jobId']}").json()["state"] == "cancelled"
    assert upload_client.delete(f"/episodes/{j['episodeId']}").json()["deleted"] is False


def test_samples_are_read_only(upload_client):
    d = api.OUT_ROOT / "up-5a5a5a5a"
    d.mkdir()
    (d / "ingest.json").write_text("{}")
    (d / "sample.json").write_text(json.dumps({"name": "S", "versions": []}))
    assert upload_client.delete("/episodes/up-5a5a5a5a").status_code == 403
    assert upload_client.post("/episodes/up-5a5a5a5a/rerun").status_code == 403
    assert d.is_dir()


def test_dollar_ceilings_per_browser_network_and_server(tmp_path):
    alerts = []
    lim = Limits(tmp_path / "l.json", 10.0, 1.0, 1.5, lambda kind, info: alerts.append(kind))
    lim.reserve("b1", "n1", "render", 0.6)
    with pytest.raises(Exception) as e:
        lim.reserve("b1", "n1", "render", 0.6)  # the browser would pass $1
    assert e.value.status_code == 429 and "This browser" in e.value.detail
    held = lim.reserve("b2", "n1", "render", 0.6)  # another browser on the same network
    with pytest.raises(Exception) as e:
        lim.reserve("b3", "n1", "render", 0.6)  # the network would pass $1.50
    assert "Your network" in e.value.detail
    with pytest.raises(Exception):
        lim.reserve("b3", "n1", "render", 0.6)
    assert alerts == ["visitor_cap", "network_cap"]  # one alert per ceiling and day
    lim.refund(held)
    lim.reserve("b3", "n1", "render", 0.6)  # a cached answer gave its hold back
    lim.reserve("b9", "n9", "upload", 0.0)  # free requests are never refused
    lim.reset_visitor("b1")
    lim.reset_network("n1")
    lim.reserve("b1", "n1", "render", 0.6)  # unblocked
    snap = Limits(tmp_path / "l.json", 10.0, 1.0, 1.5).snapshot()  # kept across a restart
    assert snap["spent"] == pytest.approx(1.8) and snap["visitors"]["b1"] == 0.6 and snap["nets"]["n1"] == 0.6

    budget = Limits(tmp_path / "b.json", 1.0, 0, 0, lambda kind, info: alerts.append(kind))
    budget.reserve("x", "y", "render", 0.85)
    with pytest.raises(Exception) as e:
        budget.reserve("z", "w", "render", 0.2)
    assert "budget" in e.value.detail and alerts[-2:] == ["budget_80", "budget_used_up"]


def test_refusals_are_recorded_and_reach_the_client(upload_client, tmp_path, monkeypatch):
    monkeypatch.setattr(api, "LIMITS", Limits(tmp_path / "l.json", 0, 0.01, 0, api.ops.alert))
    req = type("R", (), {"headers": {"x-cameo-visitor": "browser-zzzz9999"}, "client": None})()
    with pytest.raises(Exception) as e:
        api._reserve(req, "render", 0.36, "up-x")
    assert e.value.status_code == 429
    log = (api.OUT_ROOT / ".ops" / "activity.jsonl").read_text()
    assert '"kind": "refused"' in log and '"kind": "alert"' in log


def test_no_public_docs_and_bad_json_is_a_400(client):
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404
    for path in ("/episodes/up-x/prompt", "/episodes/up-x/previews", "/episodes/up-x/renders", "/episodes/up-x/masters"):
        r = client.post(path, content=b'{"shotId": "C01"', headers={"content-type": "application/json"})
        assert r.status_code in (400, 404), (path, r.status_code)


def test_only_the_uploading_browser_can_remove_or_reextract(upload_client, tmp_path):
    me, other = {"x-cameo-visitor": "browser-owner-1111"}, {"x-cameo-visitor": "browser-other-2222"}
    with clip(tmp_path).open("rb") as f:
        j = upload_client.post("/episodes", files={"file": ("clip.mp4", f, "video/mp4")}, headers=me).json()
    wait_state(upload_client, j["jobId"], "awaiting_confirmation")
    upload_client.post(f"/jobs/{j['jobId']}/cancel")
    eid = j["episodeId"]
    assert upload_client.get(f"/episodes/{eid}", headers=other).status_code == 200  # a shared link still opens
    r = upload_client.delete(f"/episodes/{eid}", headers=other)
    assert r.status_code == 403 and "Only the browser" in r.json()["detail"]
    assert upload_client.post(f"/episodes/{eid}/rerun", headers=other).status_code == 403
    assert upload_client.delete(f"/episodes/{eid}", headers=me).json()["deleted"] is True



def test_direct_upload_through_cloud_storage(upload_client, tmp_path, monkeypatch):
    from cameo_agents.storage_sync import DirStore, Sync

    class SigningStore(DirStore):
        def sign_put(self, key, content_type, max_bytes):
            return f"https://storage.example/{key}", {"Content-Type": content_type, "x-goog-content-length-range": f"0,{max_bytes}"}

    assert upload_client.post("/uploads", json={"name": "a.mp4", "size": 10, "type": "video/mp4"}).status_code == 501  # no bucket
    bucket = SigningStore(tmp_path / "bucket")
    monkeypatch.setattr(api, "STORE", Sync(api.OUT_ROOT, bucket))
    monkeypatch.setattr(api, "MAX_SECONDS", 2.0)
    r = upload_client.post("/uploads", json={"name": "clip.MP4", "size": 5_000_000, "type": "video/mp4"}).json()
    assert r["key"].startswith("incoming/") and r["key"].endswith(".mp4") and r["headers"]["x-goog-content-length-range"] == f"0,{100 * 1024 * 1024}"
    assert upload_client.post("/uploads", json={"name": "big.mp4", "size": 500 * 1024 * 1024, "type": "video/mp4"}).status_code == 413
    assert upload_client.post("/uploads", json={"name": "x.exe", "size": 10, "type": "application/x-msdownload"}).status_code == 415
    # the browser PUTs the file to the signed URL; here it lands in the stand-in bucket
    (tmp_path / "bucket" / "incoming").mkdir(parents=True)
    (tmp_path / "bucket" / r["key"]).write_bytes(clip(tmp_path).read_bytes())  # 3 s, over the 2 s limit
    too_long = upload_client.post("/episodes", json={"upload": r["key"]})
    assert too_long.status_code == 422 and too_long.json()["detail"]["code"] == "too_long"
    assert bucket.keys("incoming/") == [r["key"]]  # kept, so "use the first seconds" needs no second upload
    j = upload_client.post("/episodes", json={"upload": r["key"], "trim": True}).json()
    wait_state(upload_client, j["jobId"], "awaiting_confirmation")
    assert abs(json.loads((api.OUT_ROOT / j["episodeId"] / "ingest.json").read_text())["duration"] - 2.0) < 0.15
    for _ in range(50):
        if not bucket.keys("incoming/"):
            break
        time.sleep(0.05)
    assert bucket.keys("incoming/") == []  # the episode has its own copy
    assert upload_client.post("/episodes", json={"upload": r["key"]}).status_code == 404  # gone (or expired)
    assert upload_client.post("/episodes", json={"upload": "../out/up-x/ingest.json"}).status_code == 400
    upload_client.post(f"/jobs/{j['jobId']}/cancel")


def test_matching_prompt_gets_audience_names():
    """The model object has no audience_text until a job sets it; it must always be set (else only ids reach the prompt)."""
    from cameo_agents.catalog import audience_lines

    class Bare:
        pass

    llm = Bare()
    catalog, audiences = api.parse_catalog_body(BODY)
    job = type("J", (), {"catalog": catalog, "audiences": audiences})()
    api.job_catalog(job, llm)
    assert llm.audience_text == audience_lines(audiences)
