"""Vertex client factory, location fallback, response parsing, code-applied rules, and --dry-run (no network)."""

import json
from types import SimpleNamespace

import pytest

from cameo_agents import models
from cameo_agents.models import GeminiLLM, is_location_error, make_vertex_client, vertex_settings
from cameo_agents.pipeline import build_boxes, main, run
from cameo_agents.schemas import Box, Keyframe, LocalisedFrame, NormBox, SceneUnderstanding, Surface, is_skipped


def test_vertex_settings_and_client_read_env():
    env = {"GOOGLE_GENAI_USE_VERTEXAI": "true", "GOOGLE_CLOUD_PROJECT": "cameo-demo", "GOOGLE_CLOUD_LOCATION": ""}
    s = vertex_settings(env)
    assert s == {"vertexai": True, "project": "cameo-demo", "location": "global"}  # location defaults to global
    c = make_vertex_client(env=env)  # no credentials needed until the first request
    assert (c._api_client.vertexai, c._api_client.project, c._api_client.location) == (True, "cameo-demo", "global")
    c2 = make_vertex_client(env={**env, "GOOGLE_CLOUD_LOCATION": "us-central1"})
    assert c2._api_client.location == "us-central1"


def test_vertex_client_requires_flag_and_project():
    with pytest.raises(SystemExit, match="GOOGLE_GENAI_USE_VERTEXAI"):
        make_vertex_client(env={"GOOGLE_CLOUD_PROJECT": "p"})
    with pytest.raises(SystemExit, match="GOOGLE_CLOUD_PROJECT"):
        make_vertex_client(env={"GOOGLE_GENAI_USE_VERTEXAI": "true"})


def test_gemini_llm_from_env(monkeypatch):
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "cameo-demo")
    monkeypatch.delenv("GOOGLE_CLOUD_LOCATION", raising=False)
    llm = models.get_llm("gemini")
    assert isinstance(llm, GeminiLLM) and llm.project == "cameo-demo" and llm.location == "global"
    assert llm.client._api_client.vertexai


class _Err(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def test_location_fallback_retries_once_in_us_central1(monkeypatch):
    calls = []

    class FakeModels:
        def __init__(self, loc):
            self.loc = loc

        def generate_content(self, **kw):
            calls.append(self.loc)
            if self.loc == "global":
                raise _Err(404, "Publisher Model `gemini-3.8-flash` was not found or your project does not have access to it.")
            return SimpleNamespace(text="[]", usage_metadata=SimpleNamespace(prompt_token_count=10, candidates_token_count=2, thoughts_token_count=0, cached_content_token_count=0, total_token_count=12))

    monkeypatch.setattr(models, "make_vertex_client", lambda project, location, env=None: SimpleNamespace(models=FakeModels(location)))
    llm = GeminiLLM(client=SimpleNamespace(models=FakeModels("global")), project="p", location="global")
    req = models.GenRequest("stage2:test", llm.model, ["x"], None, "x", None)
    llm._generate(req)
    assert calls == ["global", "us-central1"] and llm.location == "us-central1"
    assert llm.usage_summary()["prompt"] == 10
    assert is_location_error(_Err(400, "Model is not supported in location asia-south1"))
    assert not is_location_error(_Err(400, "Invalid JSON payload"))


def test_parse_stage2_normalises_box_2d():
    surfaces = [Surface(label="cup", kind="table", timeVisible=8)]
    kf = Keyframe(shotId="C01", pos="mid", t=4.0, path="k.jpg")
    text = json.dumps([
        {"label": "cup", "box_2d": [100, 200, 300, 400], "mask": [[200, 100], [400, 100], [400, 300]], "occluded": 0.2, "nearFace": True, "hasText": False},
        {"label": "face", "box_2d": [0, 0, 100, 100], "occluded": 0, "nearFace": False, "hasText": False},
        {"label": "unknown thing", "box_2d": [0, 0, 10, 10], "occluded": 0, "nearFace": False, "hasText": False},
    ])
    lf = GeminiLLM.parse_stage2(text, kf, surfaces)
    cup = next(b for b in lf.boxes if b.label == "cup")
    assert cup.box.model_dump() == pytest.approx({"x": 0.2, "y": 0.1, "w": 0.2, "h": 0.2})
    assert cup.occludedByHands == 0.2 and cup.nearFace == 0.0
    assert [b.kind for b in lf.boxes] == ["table", "face"]
    assert lf.masks["cup"][0] == [0.2, 0.1]


def test_rules_applied_in_code_not_by_model():
    """High sensitivity -> skipped and blocked; apparel is a real spot. The model only reports level and kind."""
    sc = SceneUnderstanding(shotId="C04", tIn=24, tOut=32, scene={"type": "café", "mood": "sad"}, sensitivity={"level": "high", "reasons": ["bad news"]},
                            surfaces=[Surface(label="Phone in hand", kind="hand", timeVisible=8)])
    assert is_skipped(sc)
    lf = LocalisedFrame(boxes=[Box(label="Phone in hand", kind="hand", box=NormBox(x=0.3, y=0.5, w=0.2, h=0.2), t=28, shotId="C04")])
    boxes, _, _ = build_boxes(sc, [lf], is_skipped(sc))
    assert boxes[0].blocked
    # the skip rule also fires on distress words in mood/tags/reasons ("sad"), so the calm variant changes those too
    sc2 = SceneUnderstanding.model_validate({**sc.model_dump(), "scene": {"type": "café", "mood": "cheerful"}, "sensitivity": {"level": "none", "reasons": []}})
    assert not is_skipped(sc2)
    lf2 = LocalisedFrame(boxes=[Box(label="Tee", kind="apparel", box=NormBox(x=0.3, y=0.5, w=0.2, h=0.2), t=28, shotId="C04")])
    boxes2, _, _ = build_boxes(sc2, [lf2], is_skipped(sc2))
    assert not boxes2[0].blocked
    for f in ("blocked", "skipped"):
        assert f not in models._GShots.model_json_schema().__repr__()


def test_interpolates_three_keyframes():
    sc = SceneUnderstanding(shotId="C01", tIn=0, tOut=8, scene={"type": "café", "mood": "warm"})
    frames = [LocalisedFrame(boxes=[Box(label="cup", kind="table", box=NormBox(x=x, y=0.5, w=0.2, h=0.2), t=t, shotId="C01")]) for x, t in ((0.1, 0.25), (0.2, 3.0), (0.4, 7.75))]
    boxes, _, _ = build_boxes(sc, frames, False)
    assert len(boxes[0].track) == 3 and boxes[0].box.x == pytest.approx(0.2 + 0.2 * (1.0 / 4.75))


def test_dry_run_writes_requests(ingested, monkeypatch):
    for k in ("GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT"):
        monkeypatch.delenv(k, raising=False)
    out = ingested
    assert main([str(out), "--dry-run"]) == 0
    req = out / "requests"
    s1 = json.loads((req / "stage1.json").read_text())
    assert s1["parts"][0]["inline"] and s1["parts"][0]["mime"] == "video/mp4" and s1["parts"][0]["video_metadata"] == {"fps": 1}
    assert s1["config"]["media_resolution"] == "MEDIA_RESOLUTION_LOW" and s1["config"]["response_mime_type"] == "application/json"
    shot = s1["responseSchema"]["properties"]["shots"]["items"]
    assert set(shot["required"]) == {"shotId", "tIn", "tOut", "scene", "people", "cameraMotion", "sensitivity", "surfaces", "dialogueCues", "sceneGroup", "setups"}
    assert set(shot["properties"]["surfaces"]["items"]["required"]) == {"label", "kind", "timeVisible", "nearFace", "hasText"}
    stage2 = sorted(p.name for p in req.glob("stage2_*.json"))
    assert stage2 and all(n.startswith(("stage2_C01_", "stage2_C02_")) for n in stage2)
    s2 = json.loads((req / stage2[0]).read_text())
    assert s2["responseSchema"]["type"] == "ARRAY" and "box_2d" in s2["responseSchema"]["items"]["required"]
    assert not list(req.glob("stage3_*.json"))  # default --stages 1,2
    assert not (out / "scenes.json").exists()  # dry run writes no results
    idx = json.loads((req / "index.json").read_text())
    assert idx["stages"] == [1, 2] and len(idx["requests"]) == 1 + len(stage2)


def test_offline_default_stages_skip_matching(ingested):
    out = ingested
    page, web = run(out, "mock", stages=(1, 2))
    assert web["moments"] and web["placements"] == []
    assert not (out / "cache" / "mock" / "stage3.json").exists()


def test_stalled_keyframe_call_is_hedged():
    """A call with no answer after `after` seconds is sent again; the first answer wins, and a fast call is sent once."""
    import threading
    import time

    from cameo_agents.models import GeminiLLM

    llm = GeminiLLM.__new__(GeminiLLM)
    calls, lock = [], threading.Lock()

    def generate(req):
        with lock:
            n = len(calls)
            calls.append(n)
        time.sleep(2.0 if n == 0 else 0.05)  # the first call stalls
        return f"answer {n}"

    llm._generate = generate
    t0 = time.monotonic()
    assert llm._generate_hedged(object(), after=0.1) == "answer 1"
    assert time.monotonic() - t0 < 1.0 and len(calls) == 2

    calls.clear()
    llm._generate = lambda req: (calls.append(0), "fast")[1]
    assert llm._generate_hedged(object(), after=1.0) == "fast" and calls == [0]


def test_busy_vertex_is_retried_then_reported_plainly(monkeypatch):
    """A 429 is retried with backoff; anything else is raised at once."""
    from cameo_agents import models

    monkeypatch.setattr("time.sleep", lambda s: None)
    calls = []

    class Busy(Exception):
        code = 429

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise Busy("429 RESOURCE_EXHAUSTED")
        return "ok"

    assert models.with_backoff(flaky) == "ok" and len(calls) == 3

    calls.clear()

    def broken():
        calls.append(1)
        raise ValueError("bad request")

    import pytest

    with pytest.raises(ValueError):
        models.with_backoff(broken)
    assert len(calls) == 1 and models.busy(Busy("x")) and not models.busy(ValueError("x"))
