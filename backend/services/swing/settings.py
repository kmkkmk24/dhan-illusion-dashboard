"""
Swing settings: defaults <- config.yaml `swing:` <- user overrides saved from the dashboard
(data/swing/settings.json). Risk settings drive position sizing for every suggestion.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from backend.services.swing.setups import SetupParams

DEFAULTS: dict[str, Any] = {
    # money management
    "capital": 500000.0,            # trading capital in INR used for sizing
    "risk_per_trade_pct": 1.0,      # risk 1% of capital per trade (stop distance x qty)
    "max_position_pct": 20.0,       # never put more than 20% of capital in one stock
    "max_open_trades": 6,
    "max_per_sector": 2,
    "auto_trail": False,            # True = move the broker SL GTT automatically when advice says so
    # universe
    "min_price": 50.0,
    "max_price": 0.0,               # 0 = no cap
    "min_turnover_cr": 5.0,         # 20-day average traded value in INR crore (slippage control)
    "history_days": 1100,           # Dhan back-fill depth for a new stock (~3 years)
    "bhav_seed_sessions": 25,       # first run: sessions of bhavcopy to load (delivery %, turnover)
    # ranking
    "top_picks": 8,                 # the action list never shows more than this
    "example_capital": 50000.0,     # "what if I put this much in" profit example on cards and Telegram
    "earnings_block_days": 7,       # no top pick when results are due within this many days
    "max_wait_days": 10,            # accuracy: sessions allowed for an entry to trigger
    "max_hold_days": 30,            # accuracy: time stop for the evaluation
}


def _path() -> Path:
    from backend.config import DATA_DIR

    p = DATA_DIR / "swing"
    p.mkdir(parents=True, exist_ok=True)
    return p / "settings.json"


def _user() -> dict:
    try:
        return json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def get_settings() -> dict:
    from backend.config import get_config

    cfg = (get_config().get("swing") or {})
    out = dict(DEFAULTS)
    out.update({k: v for k, v in cfg.items() if k in DEFAULTS})
    out.update({k: v for k, v in _user().items() if k in DEFAULTS})
    return out


_LIMITS = {
    "capital": (10000, 1e10), "risk_per_trade_pct": (0.1, 3.0), "max_position_pct": (2, 100),
    "max_open_trades": (1, 30), "max_per_sector": (1, 10), "min_price": (1, 100000), "max_price": (0, 1e6),
    "min_turnover_cr": (0.5, 1000), "top_picks": (1, 25), "earnings_block_days": (0, 30),
    "example_capital": (1000, 1e9),
}


def save_settings(changes: dict) -> dict:
    """Validate and persist user overrides; returns the merged settings."""
    user = _user()
    for k, v in (changes or {}).items():
        if k not in DEFAULTS or k in ("history_days", "bhav_seed_sessions"):
            continue
        if isinstance(DEFAULTS[k], bool):
            user[k] = bool(v)
            continue
        try:
            x = float(v)
        except (TypeError, ValueError):
            raise ValueError(f"{k} must be a number")
        lo, hi = _LIMITS.get(k, (float("-inf"), float("inf")))
        if not lo <= x <= hi:
            raise ValueError(f"{k} must be between {lo:g} and {hi:g}")
        user[k] = int(x) if isinstance(DEFAULTS[k], int) and not isinstance(DEFAULTS[k], bool) else x
    fd, tmp = tempfile.mkstemp(dir=_path().parent, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(user, fh, indent=1)
    os.replace(tmp, _path())
    return get_settings()


def setup_params() -> SetupParams:
    from backend.config import get_config

    p = SetupParams()
    for k, v in ((get_config().get("swing") or {}).get("setup_params") or {}).items():
        if hasattr(p, k):
            setattr(p, k, type(getattr(p, k))(v))
    return p


def example_trade(entry: float, stop: float, t1: float, t2: float, capital: float) -> dict:
    """Whole shares bought with `capital` at the entry, and the rupee result at T1, T2 and the stop."""
    if not entry or entry <= 0:
        return {"capital": capital, "qty": 0}
    qty = int(capital // entry)
    inv = qty * entry

    def res(px):
        return {"amount": round(qty * (px - entry), 2), "pct": round((px / entry - 1) * 100, 2)} if px else None

    return {"capital": capital, "qty": qty, "invested": round(inv, 2),
            "t1": res(t1), "t2": res(t2), "stop": res(stop)}


def position_size(entry: float, stop: float, settings: dict, risk_mult: float = 1.0) -> dict:
    """Quantity so that a stop-out loses risk_per_trade_pct x risk_mult of capital, capped by max_position_pct."""
    cap = float(settings["capital"])
    risk_amt = cap * float(settings["risk_per_trade_pct"]) / 100 * risk_mult
    per_share = entry - stop
    if per_share <= 0 or entry <= 0 or risk_mult <= 0:
        return {"qty": 0, "risk_amount": 0.0, "position_value": 0.0, "capped": False}
    qty = int(risk_amt // per_share)
    max_qty = int(cap * float(settings["max_position_pct"]) / 100 // entry)
    capped = qty > max_qty
    qty = max(0, min(qty, max_qty))
    return {"qty": qty, "risk_amount": round(qty * per_share, 2), "position_value": round(qty * entry, 2),
            "capped": capped, "pct_of_capital": round(qty * entry / cap * 100, 1) if cap else 0}
