"""Previews: the instruction is built from the items, the endpoint caches, and the still has the frame's size (mock backend)."""

import json
import subprocess

import pytest
from fastapi.testclient import TestClient

from cameo_agents import api, preview
from cameo_agents.preview import PreviewRequest, edit_kind, instruction, where

ITEMS = [
    {"n": 1, "label": "white coffee mug in her hand", "kind": "hand", "box": {"x": 0.1, "y": 0.6, "w": 0.1, "h": 0.1},
     "product": {"brand": "FizzUp", "name": "Lemon-Lime Soda", "category": "Beverage", "description": "slim green can"}},
    {"n": 2, "label": "man's plain white t-shirt", "kind": "apparel", "box": {"x": 0.65, "y": 0.45, "w": 0.25, "h": 0.25},
     "product": {"brand": "Kora", "name": "Navy Crewneck", "category": "Fashion"}},
    {"n": 3, "label": "blank café wall", "kind": "wall", "box": {"x": 0.3, "y": 0.05, "w": 0.5, "h": 0.25},
     "product": {"brand": "Wanderly", "name": "Goa getaways", "category": "Services"}},
    {"n": 4, "label": "empty round table", "kind": "table", "box": {"x": 0.4, "y": 0.7, "w": 0.2, "h": 0.12},
     "product": {"brand": "Munchbox", "name": "Masala Makhana", "category": "Snack"}},
]


def test_edit_kinds_and_instruction():
    req = PreviewRequest.model_validate({"shotId": "C01", "audienceId": "IN", "prompt": "Make it feel like a calm morning.", "items": ITEMS})
    assert [edit_kind(i) for i in req.items] == ["replace", "garment", "display", "place"]
    assert where(req.items[0].box) == "in the lower left of the frame (a small area)"
    text = instruction(req, [])
    assert text.startswith("Edit image 1")
    assert "Replace only the white coffee mug in her hand" in text and "Dress the wearer of the man's plain white t-shirt" in text
    assert "Hang a framed poster advertising Wanderly Goa getaways" in text and "Place Munchbox Masala Makhana" in text
    assert "(follow them where they add detail): Make it feel like a calm morning." in text
    assert '"FizzUp", "Kora", "Munchbox", "Wanderly"' in text and "Do not zoom, crop" in text


def _frame(tmp_path):
    out = tmp_path / "out" / "up-test0001"
    (out / "keyframes").mkdir(parents=True)
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=720x1280", "-frames:v", "1", str(out / "keyframes" / "C01_mid.jpg")], check=True)
    (out / "ingest.json").write_text(json.dumps({"video": "", "width": 720, "height": 1280, "shots": [{"shotId": "C01", "tIn": 0, "tOut": 4, "keyframes": [{"pos": "mid", "t": 2.0}]}]}))
    return out


def test_preview_endpoint_caches(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "OUT_ROOT", tmp_path / "out")
    monkeypatch.setenv("CAMEO_IMAGE", "mock")
    out = _frame(tmp_path)
    c = TestClient(api.app)
    body = {"shotId": "C01", "audienceId": "IN", "prompt": "Place the products.", "items": ITEMS[:2]}
    r1 = c.post("/episodes/up-test0001/previews", json=body)
    assert r1.status_code == 200, r1.text
    j = r1.json()
    assert j["cached"] is False and j["url"] == f"/episodes/up-test0001/previews/{j['id']}.png"
    assert c.post("/episodes/up-test0001/previews", json=body).json()["cached"] is True
    png = c.get(j["url"])
    assert png.status_code == 200 and png.headers["content-type"] == "image/png"
    meta = json.loads((out / "previews" / f"{j['id']}.json").read_text())
    assert (meta["width"], meta["height"]) == (720, 1280) and meta["instruction"].startswith("Edit image 1")
    assert c.get("/config").json()["imagePrice"] == preview.PRICE_PER_IMAGE


@pytest.mark.parametrize("bad", [{"items": []}, {"shotId": "../x"}, {"prompt": ""}])
def test_preview_rejects_bad_requests(tmp_path, monkeypatch, bad):
    monkeypatch.setattr(api, "OUT_ROOT", tmp_path / "out")
    monkeypatch.setenv("CAMEO_IMAGE", "mock")
    _frame(tmp_path)
    body = {"shotId": "C01", "audienceId": "IN", "prompt": "x", "items": ITEMS[:1], **bad}
    assert TestClient(api.app).post("/episodes/up-test0001/previews", json=body).status_code == 400
