"""Shopper-event ingestion and analytics router.

POST /events                              append one event to <out>/<ep>/events.jsonl
GET  /episodes/{episode_id}/analytics     aggregate real events

Each event carries the browser's visitor id, and analytics counts only the asking browser's own events: a sample is
one episode on the server, but every browser places its own products in it, so its numbers must not mix.
"""

from __future__ import annotations

import json
import math
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, HTTPException, Request

from starlette.concurrency import run_in_threadpool

from .ops import allow_event, visitor_of

router = APIRouter()

_ID_RE = re.compile(r"^[a-z0-9-]+$")
_TYPES = {
    "impression": "impressions",
    "shop_click": "shop_clicks",
    "product_view": "product_views",
    "product_save": "product_saves",
}
_OPTIONAL = ("shotId", "boxId", "productId", "audienceId")
_MAX_BODY = 4096
_MAX_STR = 128
_MAX_T = 86400

_lock = threading.Lock()


def _default_root() -> Path:
    return Path(__file__).resolve().parent.parent / "out"


_get_out_root: Callable[[], Path] = _default_root


_ensure: Callable[[str], None] = lambda episode_id: None  # noqa: E731


def configure(get_out_root: Callable[[], Path], ensure: Callable[[str], None] | None = None) -> None:
    """Set the callable returning the output root (called on every request), and the one that restores an episode."""
    global _get_out_root, _ensure
    _get_out_root = get_out_root
    if ensure is not None:
        _ensure = ensure


def out_root() -> Path:
    return Path(_get_out_root())


def _episode_dir(episode_id: Any) -> Path:
    if not isinstance(episode_id, str) or not _ID_RE.match(episode_id):
        raise HTTPException(400, "episodeId must match ^[a-z0-9-]+$")
    _ensure(episode_id)
    d = out_root() / episode_id
    if not d.is_dir():
        raise HTTPException(404, f"episode not found: {episode_id}")
    return d


def _bad(msg: str) -> HTTPException:
    return HTTPException(400, msg)


@router.post("/events")
async def post_event(request: Request) -> dict:
    raw = await request.body()
    if len(raw) > _MAX_BODY:
        raise HTTPException(413, "request body too large (max 4 KB)")
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise _bad("body must be valid JSON")
    if not isinstance(body, dict):
        raise _bad("body must be a JSON object")

    visitor = visitor_of(request)
    if not allow_event(visitor):
        raise HTTPException(429, "too many events today")
    ep_dir = await run_in_threadpool(_episode_dir, body.get("episodeId"))  # may restore it from Cloud Storage

    sid = body.get("sessionId")
    if not isinstance(sid, str) or not sid or len(sid) > _MAX_STR:
        raise _bad("sessionId must be a non-empty string of at most 128 chars")
    if body.get("type") not in _TYPES:
        raise _bad(f"type must be one of {sorted(_TYPES)}")
    t = body.get("t")
    if (
        isinstance(t, bool)
        or not isinstance(t, (int, float))
        or not math.isfinite(t)
        or t < 0
        or t > _MAX_T
    ):
        raise _bad("t must be a finite number between 0 and 86400")

    event: dict[str, Any] = {
        "episodeId": body["episodeId"],
        "sessionId": sid,
        "type": body["type"],
        "t": t,
    }
    for k in _OPTIONAL:
        v = body.get(k)
        if v is None:
            continue
        if not isinstance(v, str) or len(v) > _MAX_STR:
            raise _bad(f"{k} must be a string of at most 128 chars")
        event[k] = v
    event["at"] = time.time()
    event["visitor"] = visitor

    line = json.dumps(event, separators=(",", ":")) + "\n"
    with _lock:
        with open(ep_dir / "events.jsonl", "a", encoding="utf-8") as f:
            f.write(line)
    return {"ok": True}


def _zero() -> dict[str, int]:
    return {k: 0 for k in _TYPES.values()}


@router.get("/episodes/{episode_id}/analytics")
def analytics(episode_id: str, request: Request) -> dict:
    ep_dir = _episode_dir(episode_id)
    me = visitor_of(request)
    totals = _zero()
    by_product: dict[str, dict[str, int]] = {}
    by_aud: dict[str, dict[str, int]] = {}
    sec_counts: dict[int, dict[str, int]] = {}
    max_sec = -1

    path = ep_dir / "events.jsonl"
    if path.is_file():
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    ev = json.loads(line)
                    if ev.get("visitor") != me:
                        continue
                    key = _TYPES[ev["type"]]
                    t = ev["t"]
                    if isinstance(t, bool) or not isinstance(t, (int, float)):
                        continue
                    sec = int(math.floor(t))
                except (ValueError, KeyError, TypeError, OverflowError):
                    continue
                if sec < 0:
                    continue
                totals[key] += 1
                for field, bucket in (("productId", by_product), ("audienceId", by_aud)):
                    v = ev.get(field)
                    if isinstance(v, str) and v:
                        bucket.setdefault(v, _zero())[key] += 1
                max_sec = max(max_sec, sec)
                if key in ("impressions", "shop_clicks"):
                    sec_counts.setdefault(sec, {"impressions": 0, "shop_clicks": 0})[key] += 1

    duration_sec = -1
    ingest = ep_dir / "ingest.json"
    if ingest.is_file():
        try:
            d = json.loads(ingest.read_text(encoding="utf-8")).get("duration")
            if isinstance(d, (int, float)) and not isinstance(d, bool) and math.isfinite(d) and d >= 0:
                duration_sec = int(math.floor(d))
        except (ValueError, AttributeError, OSError):
            pass

    last = max(duration_sec, max_sec)
    series = []
    for s in range(0, last + 1):
        c = sec_counts.get(s, {})
        series.append(
            {"t": s, "impressions": c.get("impressions", 0), "shop_clicks": c.get("shop_clicks", 0)}
        )

    return {
        "totals": totals,
        "byProduct": [{"productId": k, **by_product[k]} for k in sorted(by_product)],
        "byAudience": [{"audienceId": k, **by_aud[k]} for k in sorted(by_aud)],
        "series": series,
    }
