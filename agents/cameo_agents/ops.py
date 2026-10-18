"""Operator analytics: who visited, which samples they opened, what they made and what it cost.

The server records every step itself (a visit beacon from the web app, uploads, detections, previews, renders, drawn
boxes, prompts, refusals), so the numbers do not depend on the browser. Each event is appended to
out/.ops/activity.jsonl and printed as one JSON log line, so Cloud Logging keeps the full history across redeploys
(Logs Explorer: jsonPayload.cameo_ops=true).

Visitors are anonymous: the web app sends a random id per browser (X-Cameo-Visitor); the network address is stored only
as a salted hash. The dashboard endpoints need `Authorization: Bearer <CAMEO_ADMIN_TOKEN>` and are off without it.

    POST /ops/visit         {path, episodeId?, session, context?}: one page view; the first of a tab session carries the
                            browser's own context (country from its time zone, language, browser, device, referrer)
    POST /ops/event         {action, episodeId?, session, props}: one thing the visitor did (ACTIONS)
    GET  /admin/visitor/{id} one visitor's profile, today's spend against the browser and network ceilings, and timeline
    GET  /admin/summary     ?days=N (0 = everything): totals, series, samples, visitors, recent activity, limits
    POST /admin/limits      {budget?, visitorCap?, networkCap?, resetSpend?, resetVisitor?, resetNetwork?, resetAll?}
    POST /admin/test-alert  logs one test alert, to check the email alerts end to end
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException, Request

router = APIRouter()
_lock = threading.Lock()
_root: Callable[[], Path] = lambda: Path(__file__).resolve().parent.parent / "out"  # noqa: E731
_limits: Callable[[], Any] = lambda: None  # noqa: E731
_VISITOR_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")

ACTIONS = {"place_product", "remove_product", "draw_box", "edit_prompt", "approve", "add_product", "add_audience", "restore_sample",
           "viewer_shop_click", "viewer_product_view", "viewer_product_save", "engaged"}
CONTEXT = ("country", "timezone", "language", "browser", "os", "device", "screen", "referrer", "utmSource", "utmCampaign")
EVENTS_PER_VISITOR_DAY = 3000  # beacons beyond this are dropped, so no one can flood the log
_seen: dict[str, int] = {}
_seen_day = ""
SECTIONS = ("catalog", "scenes", "previews", "render", "watch", "analytics")


def _clean(v: Any) -> Any:
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        return round(float(v), 3)
    return re.sub(r"[\x00-\x1f]", "", str(v))[:80]


def _allow(visitor: str) -> bool:
    global _seen_day
    day = time.strftime("%Y-%m-%d", time.gmtime())
    with _lock:
        if day != _seen_day:
            _seen.clear()
            _seen_day = day
        _seen[visitor] = _seen.get(visitor, 0) + 1
        return _seen[visitor] <= EVENTS_PER_VISITOR_DAY


def allow_event(visitor: str) -> bool:
    """Viewer events (events.py) get their own daily allowance per browser."""
    return _allow(f"viewer:{visitor}")


async def _body(request: Request) -> dict:
    raw = await request.body()
    if len(raw) > 4096:
        raise HTTPException(413, "too large")
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        body = {}
    return body if isinstance(body, dict) else {}


def _episode(v: Any) -> Optional[str]:
    return v if isinstance(v, str) and re.fullmatch(r"[a-z0-9-]{1,40}", v) else None


def section_of(path: str) -> str:
    m = re.match(r"^/p/[^/]+/([a-z]+)", path)
    if m and m.group(1) in SECTIONS:
        return m.group(1)
    return "landing" if path in ("", "/") else "processing" if path.endswith("/processing") else "other"


def configure(root: Callable[[], Path], limits: Callable[[], Any]) -> None:
    global _root, _limits
    _root, _limits = root, limits


def _dir() -> Path:
    d = _root() / ".ops"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _salt() -> bytes:
    p = _dir() / "salt"
    if not p.is_file():
        p.write_text(secrets.token_hex(16))
    return p.read_text().encode()


def _ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() or (request.client.host if request.client else "")) or "unknown"


def net_of(request: Request) -> str:
    """The client's network address as a salted hash, used only for the per-network spending ceiling."""
    return "ip-" + hashlib.sha256(_salt() + _ip(request).encode()).hexdigest()[:12]


def visitor_of(request: Request) -> str:
    """The browser's anonymous id, else its network hash."""
    v = request.headers.get("x-cameo-visitor", "")
    return v if _VISITOR_RE.match(v) else net_of(request)


def who(request: Request) -> dict:
    return {"visitor": visitor_of(request), "net": net_of(request)}


def record(kind: str, visitor: str = "server", episode: Optional[str] = None, cost: float = 0.0, net: Optional[str] = None, **extra: Any) -> None:
    """Append one event (never raises: analytics must not break a request)."""
    ev = {"t": round(time.time(), 3), "kind": kind, "visitor": visitor, "net": net, "episode": episode, "cost": round(float(cost or 0), 5),
          **{k: v for k, v in extra.items() if v is not None}}
    try:
        with _lock, (_dir() / "activity.jsonl").open("a") as f:
            f.write(json.dumps(ev, ensure_ascii=False) + "\n")
        print(json.dumps({"cameo_ops": True, **ev}, ensure_ascii=False), flush=True)
    except Exception:  # noqa: BLE001
        pass


ALERT_TEXT = {
    "visitor_cap": "A browser reached its daily spending ceiling (${spent:.2f} of ${cap:g}); its paid requests are refused until tomorrow or until it is unblocked on /admin.",
    "network_cap": "A network reached its daily spending ceiling (${spent:.2f} of ${cap:g}); paid requests from it are refused until tomorrow or until it is unblocked on /admin.",
    "budget_80": "The server has spent ${spent:.2f} of its ${budget:g} daily budget (80 %).",
    "budget_used_up": "The server's daily budget of ${budget:g} is used up; new generations are refused until tomorrow (UTC) or until the budget is raised on /admin.",
    "test": "Test alert from the Cameo operator dashboard. Email alerts are working.",
}


def alert(kind: str, info: dict) -> None:
    """One operator alert: a WARNING log line Cloud Monitoring emails (jsonPayload.cameo_alert), and an activity event."""
    message = ALERT_TEXT.get(kind, kind).format(**{"spent": 0, "cap": 0, "budget": 0, **info})
    try:
        print(json.dumps({"severity": "WARNING", "cameo_alert": kind, "message": f"Cameo: {message}", **info}, ensure_ascii=False), flush=True)
    except Exception:  # noqa: BLE001
        pass
    record("alert", info.get("visitor", "server"), None, net=info.get("net"), alert=kind, message=message)


def _events(since: float) -> list[dict]:
    p = _dir() / "activity.jsonl"
    if not p.is_file():
        return []
    out = []
    for line in p.read_text().splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("t", 0) >= since:
            out.append(ev)
    return out


def _sample_names() -> dict[str, str]:
    names = {}
    for f in _root().glob("*/sample.json"):
        try:
            names[f.parent.name] = json.loads(f.read_text())["name"]
        except (OSError, ValueError, KeyError):
            continue
    return names


def _admin(request: Request) -> None:
    token = os.environ.get("CAMEO_ADMIN_TOKEN", "")
    if not token:
        raise HTTPException(404, "not found")
    given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(given, token):
        raise HTTPException(401, "admin token required")


@router.post("/ops/visit")
async def visit(request: Request) -> dict:
    body = await _body(request)
    path = str(body.get("path") or "")[:200]
    episode = _episode(body.get("episodeId"))
    w = who(request)
    if path.startswith("/admin") or not _allow(w["visitor"]):
        return {"ok": True}
    sample = bool(episode and (_root() / episode / "sample.json").is_file())
    ctx = body.get("context") if isinstance(body.get("context"), dict) else {}
    record("visit", **w, episode=episode, path=path, section=section_of(path), sample=sample or None, session=_clean(body.get("session")),
           entry=bool(body.get("entry")) or None, ua=request.headers.get("user-agent", "")[:160],
           **{k: _clean(ctx[k]) for k in CONTEXT if ctx.get(k)})
    return {"ok": True}


@router.post("/ops/event")
async def event(request: Request) -> dict:
    body = await _body(request)
    action = body.get("action")
    w = who(request)
    if action not in ACTIONS or not _allow(w["visitor"]):
        return {"ok": True}
    props = body.get("props") if isinstance(body.get("props"), dict) else {}
    props = {re.sub(r"[^A-Za-z]", "", str(k))[:20]: _clean(v) for k, v in list(props.items())[:6]}
    record("action", **w, episode=_episode(body.get("episodeId")), action=action, session=_clean(body.get("session")),
           **{k: v for k, v in props.items() if k and k not in ("kind", "visitor", "net", "episode", "cost", "t")})
    return {"ok": True}


# A headless or scripted browser (tests, monitors, crawlers): counted apart from people. Its spending still counts.
_AUTOMATED_UA = re.compile(r"headless|bot\b|crawl|spider|curl|python|wget|lighthouse|playwright|puppeteer|phantomjs", re.I)


def automated(ua: str) -> bool:
    return not ua or bool(_AUTOMATED_UA.search(ua))


def summarize(events: list[dict], days: int, now: float, names: dict[str, str]) -> dict:
    ua_of: dict[str, str] = {}
    for ev in events:
        if ev["kind"] == "visit" and ev.get("ua"):
            ua_of.setdefault(ev.get("visitor", ""), ev["ua"])
    bots = {ev.get("visitor") for ev in events if ev.get("visitor", "server") != "server" and automated(ua_of.get(ev.get("visitor", ""), ""))}
    hourly = days and days <= 2
    bucket = (lambda t: time.strftime("%Y-%m-%d %H:00", time.gmtime(t))) if hourly else (lambda t: time.strftime("%Y-%m-%d", time.gmtime(t)))
    series: dict[str, Counter] = defaultdict(Counter)
    visitors: dict[str, dict] = {}
    samples: dict[str, dict] = {}
    actions: Counter = Counter()
    tot: Counter = Counter()
    spend = 0.0
    for ev in events:
        k, v, ep, cost = ev["kind"], ev.get("visitor", "server"), ev.get("episode"), float(ev.get("cost") or 0)
        b = bucket(ev["t"])
        row = visitors.setdefault(v, {"visitor": v, "net": ev.get("net"), "first": ev["t"], "last": ev["t"], "visits": 0, "samples": set(),
                                       "uploads": 0, "images": 0, "renders": 0, "spend": 0.0, "refused": 0, "ua": "", "sessions": set(),
                                       "actions": 0, "seconds": 0, "sections": set(), "lastAction": "", **{c: "" for c in CONTEXT}})
        row["first"], row["last"] = min(row["first"], ev["t"]), max(row["last"], ev["t"])
        row["net"] = row["net"] or ev.get("net")
        if v in bots and k in ("visit", "action"):  # their page views are not people's; the row stays for the operator
            tot["automatedVisits"] += k == "visit"
            row["visits"] += k == "visit"
            row["ua"] = row["ua"] or ev.get("ua", "")
            continue
        if k in ("visit", "action") and ev.get("session"):
            row["sessions"].add(ev["session"])
        if k == "action":
            a = ev.get("action", "")
            if a == "engaged":
                row["seconds"] += int(ev.get("seconds") or 0)
                tot["engagedSeconds"] += int(ev.get("seconds") or 0)
            else:
                actions[a] += 1
                row["actions"] += 1
                row["lastAction"] = a
                series[b]["actions"] += 1
        if k == "visit":
            tot["visits"] += 1
            series[b]["visits"] += 1
            row["visits"] += 1
            row["ua"] = row["ua"] or ev.get("ua", "")
            row["sections"].add(ev.get("section") or section_of(ev.get("path", "")))
            for c in CONTEXT:
                if ev.get(c):
                    row[c] = ev[c]
            if ev.get("sample") and ep:
                s = samples.setdefault(ep, {"id": ep, "name": names.get(ep, ep), "views": 0, "visitors": set()})
                s["views"] += 1
                s["visitors"].add(v)
                row["samples"].add(ep)
        elif k == "upload":
            tot["uploads"] += 1
            row["uploads"] += 1
            series[b]["uploads"] += 1
        elif k == "preview":
            if ev.get("cached"):
                tot["imagesCached"] += 1
            else:
                tot["images"] += 1
                row["images"] += 1
                series[b]["images"] += 1
        elif k == "render_start":
            tot["rendersStarted"] += 1
        elif k == "render_done":
            tot["renders"] += 1
            tot["rendersPassed"] += 1 if ev.get("passed") else 0
            series[b]["renders"] += 1
            owner = visitors.get(ev.get("owner") or "")
            if owner:
                owner["renders"] += 1
        elif k == "render_failed":
            tot["rendersFailed"] += 1
        elif k == "detect_done":
            tot["detections"] += 1
            series[b]["detections"] += 1
        elif k in ("identify", "prompt", "match_done"):
            tot[k] += 1
        elif k == "refused":
            tot["refused"] += 1
            row["refused"] += 1
        elif k == "alert":
            tot["alerts"] += 1
        if cost:
            spend += cost
            series[b]["spend"] = round(series[b]["spend"] + cost, 4)
            target = visitors.get(ev.get("owner") or "") if k == "render_done" else row
            if target:
                target["spend"] = round(target["spend"] + cost, 4)
    for sid, name in names.items():  # every sample, opened or not
        samples.setdefault(sid, {"id": sid, "name": name, "views": 0, "visitors": set()})
    span = (2 if hourly else days) or 0
    if span:  # empty hours or days are part of the timeline too
        step = 3600 if hourly else 86400
        for i in range(int(span * 86400 / step)):
            series.setdefault(bucket(now - i * step), Counter())
    rows = [r for r in visitors.values() if r["visitor"] != "server"]
    for r in rows:
        r["automated"] = r["visitor"] in bots
    people = [r for r in rows if not r["automated"]]
    reached = Counter()
    for r in rows:
        r["samples"] = sorted(names.get(s, s) for s in r["samples"])
        r["sessions"] = len(r["sessions"])
        r["source"] = r["referrer"] or (f"{r['utmSource']} (campaign)" if r["utmSource"] else "")
        secs = r["sections"]
        r["sections"] = sorted(secs)
        steps = {"landed": bool(r["visits"]), "sample": bool(r["samples"]) or r["uploads"] > 0, "scenes": "scenes" in secs,
                 "tried": r["actions"] > 0 or r["uploads"] > 0, "previews": "previews" in secs, "render": "render" in secs,
                 "watch": bool({"watch", "analytics"} & secs), "generated": r["images"] > 0 or r["renders"] > 0}
        if not r["automated"]:
            reached.update(k for k, on in steps.items() if on)
    tally = lambda key: [{"name": n, "visitors": c} for n, c in Counter(r[key] or "Unknown" for r in people).most_common(12)]  # noqa: E731
    day = time.strftime("%Y-%m-%d", time.gmtime(now))
    return {
        "days": days,
        "generatedAt": now,
        "totals": {**tot, "visitors": len(people), "automated": len(rows) - len(people), "networks": len({r["net"] for r in people if r["net"]}),
                   "spend": round(spend, 4), "sessions": sum(r["sessions"] for r in people), "actions": sum(actions.values())},
        "funnel": [{"step": k, "visitors": reached[k]} for k in ("landed", "sample", "scenes", "tried", "previews", "render", "watch", "generated")],
        "actions": [{"action": a, "count": c} for a, c in actions.most_common()],
        "audience": {"countries": tally("country"), "devices": tally("device"), "browsers": tally("browser"), "os": tally("os"),
                     "languages": tally("language"), "referrers": [x for x in tally("source") if x["name"] != "Unknown"]},
        "series": [{"bucket": b, **c} for b, c in sorted(series.items())],
        "hourly": bool(hourly),
        "samples": sorted(({**s, "visitors": len(s["visitors"])} for s in samples.values()), key=lambda s: -s["views"]),
        "visitors": sorted(rows, key=lambda r: (r["automated"], -r["last"]))[:300],
        "recent": [{**e, "episodeName": names.get(e.get("episode") or "", None)} for e in events[-300:]][::-1],
        "today": day,
    }


def console_links() -> dict:
    """Where the same deployment is seen in Google Cloud: logs, the service's metrics, billing (empty off Cloud Run)."""
    project, service = os.environ.get("GOOGLE_CLOUD_PROJECT", ""), os.environ.get("K_SERVICE", "")
    if not project:
        return {}
    q = f"?project={project}"
    links = {"logs": f"https://console.cloud.google.com/logs/query;query=jsonPayload.cameo_ops%3Dtrue{q}",
             "billing": f"https://console.cloud.google.com/billing/linkedaccount{q}",
             "vertex": f"https://console.cloud.google.com/vertex-ai/dashboard{q}"}
    if service:
        links["service"] = f"https://console.cloud.google.com/run/detail/{os.environ.get('CAMEO_REGION', 'asia-southeast1')}/{service}/metrics{q}"
    return links


@router.get("/admin/summary")
def admin_summary(request: Request, days: int = 7) -> dict:
    _admin(request)
    now = time.time()
    since = 0.0 if days <= 0 else now - days * 86400
    out = summarize(_events(since), max(0, days), now, _sample_names())
    lim = _limits()
    out["limits"] = lim.snapshot() if lim else None
    out["console"] = console_links()
    return out


@router.post("/admin/limits")
async def admin_limits(request: Request) -> dict:
    _admin(request)
    lim = _limits()
    if lim is None:
        raise HTTPException(503, "limits are not configured")
    body = await _body(request)
    caps = {}
    for key in ("budget", "visitorCap", "networkCap"):
        if key in body:
            v = body[key]
            if not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0 or v > 10000:
                raise HTTPException(400, f"{key} must be a number of USD between 0 and 10000 (0 = no limit)")
            caps[key] = float(v)
    if caps:
        lim.set_caps(caps.get("budget"), caps.get("visitorCap"), caps.get("networkCap"))
    if body.get("resetSpend"):
        lim.reset_spend()
    if isinstance(body.get("resetVisitor"), str):
        lim.reset_visitor(body["resetVisitor"])
    if isinstance(body.get("resetNetwork"), str):
        lim.reset_network(body["resetNetwork"])
    if body.get("resetAll"):
        lim.reset_visitor(None)
    record("admin", "operator", None, **{k: body[k] for k in ("budget", "visitorCap", "networkCap", "resetSpend", "resetVisitor", "resetNetwork", "resetAll") if k in body})
    return lim.snapshot()


@router.post("/admin/test-alert")
def admin_test_alert(request: Request) -> dict:
    _admin(request)
    alert("test", {"spent": 0})
    return {"ok": True}


@router.get("/admin/visitor/{visitor}")
def admin_visitor(visitor: str, request: Request) -> dict:
    _admin(request)
    if not _VISITOR_RE.match(visitor):
        raise HTTPException(400, "bad visitor id")
    names = _sample_names()
    mine = [e for e in _events(0) if e.get("visitor") == visitor or e.get("owner") == visitor]
    if not mine:
        raise HTTPException(404, "no such visitor")
    row = summarize(mine, 0, time.time(), names)["visitors"]
    profile = next((r for r in row if r["visitor"] == visitor), None)
    lim = _limits()
    snap = lim.snapshot() if lim else None
    net = (profile or {}).get("net")
    blocked = (snap or {}).get("blocked", {})
    return {"profile": profile, "spentToday": (snap or {}).get("visitors", {}).get(visitor, 0.0), "networkSpentToday": (snap or {}).get("nets", {}).get(net or "", 0.0),
            "visitorCap": (snap or {}).get("visitorCap"), "networkCap": (snap or {}).get("networkCap"),
            "blocked": visitor in blocked.get("visitors", []), "networkBlocked": bool(net) and net in blocked.get("nets", []),
            "timeline": [{**e, "episodeName": names.get(e.get("episode") or "", None)} for e in mine[-500:]][::-1]}
