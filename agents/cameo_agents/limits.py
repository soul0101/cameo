"""Spending ceilings for a public deployment, in dollars per UTC day: one browser, one network, the whole server.

Nothing is counted per request: visitors can try everything as often as they like. Every paid request reserves its
estimated cost before the model is called and gives it back when the answer came from the cache. A request is refused
(HTTP 429, with a plain message) only when it would take a browser past its ceiling, a network past its ceiling, or
the server past its daily budget; samples and everything already made keep working.

A browser is its anonymous visitor id; a network is a salted hash of its address (ops.net_of), used for nothing but
its ceiling. When a ceiling is reached, and when the server passes 80 % of its budget, one alert line is logged for
that ceiling and day (`cameo_alert`, severity WARNING); a Cloud Monitoring policy emails those.

Spend is kept per UTC day in out/.limits.json, so a restart does not reset it. The operator dashboard changes the
ceilings (kept in out/.limits-config.json) and clears a browser's, a network's or the whole day's spend.

    CAMEO_DAILY_BUDGET_USD    whole server, default 60 (0 = no limit)
    CAMEO_VISITOR_CAP_USD     one browser, default 10
    CAMEO_NETWORK_CAP_USD     one network, default 25
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from fastapi import HTTPException

ALERT_AT = 0.8  # share of the server budget that sends a warning


@dataclass
class Reservation:
    visitor: str
    net: str
    usd: float


def _blank(day: str) -> dict:
    return {"day": day, "spent": 0.0, "visitors": {}, "nets": {}, "alerted": []}


class Limits:
    def __init__(self, path: Path, budget: float, visitor_cap: float, network_cap: float, alert: Optional[Callable[[str, dict], None]] = None):
        self.path = path
        self.config = path.with_name(path.stem + "-config.json")
        self.budget, self.visitor_cap, self.network_cap = budget, visitor_cap, network_cap
        try:
            saved = json.loads(self.config.read_text())
            self.budget = float(saved.get("budget", self.budget))
            self.visitor_cap = float(saved.get("visitorCap", self.visitor_cap))
            self.network_cap = float(saved.get("networkCap", self.network_cap))
        except (OSError, ValueError, TypeError):
            pass
        self.alert = alert or (lambda kind, info: None)
        self._lock = threading.Lock()
        self._state = self._load()

    @staticmethod
    def _day() -> str:
        return time.strftime("%Y-%m-%d", time.gmtime())

    def _load(self) -> dict:
        try:
            s = json.loads(self.path.read_text())
            if s.get("day") == self._day():
                return {**_blank(s["day"]), **s}
        except (OSError, ValueError, KeyError):
            pass
        return _blank(self._day())

    def _today(self) -> dict:
        if self._state["day"] != self._day():
            self._state = _blank(self._day())
        return self._state

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._state))
        tmp.replace(self.path)

    def _once(self, key: str, kind: str, info: dict) -> None:
        """One alert per ceiling and day (called under the lock; the alert itself only logs)."""
        if key not in self._state["alerted"]:
            self._state["alerted"].append(key)
            self.alert(kind, info)

    def reserve(self, visitor: str, net: str, kind: str, usd: float) -> Reservation:
        """Hold `usd` against the browser, its network and the server for today, or raise 429."""
        with self._lock:
            s = self._today()
            if usd > 0:
                spent_v, spent_n = s["visitors"].get(visitor, 0.0), s["nets"].get(net, 0.0)
                if self.budget and s["spent"] + usd > self.budget:
                    self._once("budget", "budget_used_up", {"spent": s["spent"], "budget": self.budget, "what": kind})
                    self._save()
                    raise HTTPException(429, "Today's generation budget for this demo is used up. Samples and everything already made still work; new generations open again tomorrow (UTC).")
                if self.visitor_cap and spent_v + usd > self.visitor_cap:
                    self._once(f"v:{visitor}", "visitor_cap", {"visitor": visitor, "spent": spent_v, "cap": self.visitor_cap, "what": kind})
                    self._save()
                    raise HTTPException(429, f"This browser has used its ${self.visitor_cap:g} of generations for today. Samples and everything you made still work.")
                if self.network_cap and spent_n + usd > self.network_cap:
                    self._once(f"n:{net}", "network_cap", {"net": net, "spent": spent_n, "cap": self.network_cap, "what": kind})
                    self._save()
                    raise HTTPException(429, f"Your network has used its ${self.network_cap:g} of generations for today. Samples and everything already made still work.")
                s["visitors"][visitor] = round(spent_v + usd, 4)
                s["nets"][net] = round(spent_n + usd, 4)
                s["spent"] = round(s["spent"] + usd, 4)
                if self.budget and s["spent"] >= ALERT_AT * self.budget:
                    self._once("budget80", "budget_80", {"spent": s["spent"], "budget": self.budget})
                self._save()
        return Reservation(visitor, net, usd)

    def refund(self, r: Reservation) -> None:
        """Give a reservation back (the answer was cached, or the request failed before any model call)."""
        if r.usd <= 0:
            return
        with self._lock:
            s = self._today()
            for book, key in ((s["visitors"], r.visitor), (s["nets"], r.net)):
                if key in book:
                    book[key] = round(max(0.0, book[key] - r.usd), 4)
            s["spent"] = round(max(0.0, s["spent"] - r.usd), 4)
            self._save()

    def status(self) -> dict:
        with self._lock:
            s = self._today()
            return {"day": s["day"], "spent": s["spent"], "budget": self.budget}

    def snapshot(self) -> dict:
        """Everything the dashboard shows: the ceilings, today's spend in total, per browser and per network."""
        with self._lock:
            s = self._today()
            return {"day": s["day"], "spent": s["spent"], "budget": self.budget, "visitorCap": self.visitor_cap, "networkCap": self.network_cap,
                    "visitors": dict(s["visitors"]), "nets": dict(s["nets"]),
                    "blocked": {"visitors": sorted(k[2:] for k in s["alerted"] if k.startswith("v:")),
                                "nets": sorted(k[2:] for k in s["alerted"] if k.startswith("n:"))}}  # refused at least once today

    def set_caps(self, budget: Optional[float] = None, visitor_cap: Optional[float] = None, network_cap: Optional[float] = None) -> None:
        with self._lock:
            if budget is not None:
                self.budget = budget
            if visitor_cap is not None:
                self.visitor_cap = visitor_cap
            if network_cap is not None:
                self.network_cap = network_cap
            self.config.parent.mkdir(parents=True, exist_ok=True)
            self.config.write_text(json.dumps({"budget": self.budget, "visitorCap": self.visitor_cap, "networkCap": self.network_cap}))
            s = self._today()
            s["alerted"] = [k for k in s["alerted"] if k not in ("budget", "budget80")]  # a new budget can warn again
            self._save()

    def reset_spend(self) -> None:
        """Start the day's server budget over (the browsers and networks keep theirs)."""
        with self._lock:
            s = self._today()
            s["spent"] = 0.0
            s["alerted"] = [k for k in s["alerted"] if k not in ("budget", "budget80")]
            self._save()

    def reset_visitor(self, visitor: Optional[str]) -> None:
        """Clear one browser's spend for today (it can generate again), or every browser's and network's (None)."""
        with self._lock:
            s = self._today()
            if visitor is None:
                s["visitors"], s["nets"] = {}, {}
                s["alerted"] = [k for k in s["alerted"] if not k.startswith(("v:", "n:"))]
            else:
                s["visitors"].pop(visitor, None)
                s["alerted"] = [k for k in s["alerted"] if k != f"v:{visitor}"]
            self._save()

    def reset_network(self, net: str) -> None:
        with self._lock:
            s = self._today()
            s["nets"].pop(net, None)
            s["alerted"] = [k for k in s["alerted"] if k != f"n:{net}"]
            self._save()


def from_env(out_root: Path, alert: Optional[Callable[[str, dict], None]] = None) -> Limits:
    return Limits(out_root / ".limits.json", float(os.environ.get("CAMEO_DAILY_BUDGET_USD", "60")), float(os.environ.get("CAMEO_VISITOR_CAP_USD", "10")),
                  float(os.environ.get("CAMEO_NETWORK_CAP_USD", "25")), alert)
