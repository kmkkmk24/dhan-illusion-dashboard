"""
Sector rotation (Relative Rotation Graph, RRG).

Shows where money is rotating between sectors, measured as each sector index's
relative strength against Nifty 50:

  RS           = 100 * sector_close / nifty_close
  RS-Ratio     = 100 + z-score of RS over `window` bars         (trend of relative strength)
  RS-Momentum  = 100 + z-score of RS-Ratio's 1-bar % change     (rate of change of that trend)

Quadrants (sectors normally rotate clockwise):
  Improving (ratio < 100, momentum > 100) -> Leading (> 100, > 100)
  -> Weakening (> 100, < 100) -> Lagging (< 100, < 100) -> Improving ...

This is an open approximation of the JdK RS-Ratio / RS-Momentum idea, not the
proprietary formula. It measures relative performance, not traded money: the
"inflow"/"outflow" wording in the UI means relative strength rotating toward or
away from a sector.

The result is computed from the history that SectorAnalyzer already downloads
and is cached as JSON so the UI can read it without hitting Dhan.
"""

from __future__ import annotations

import json
import logging
import math
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")

# window = z-score lookback, tail = points of history to draw
TIMEFRAMES = {
    "daily": {"window": 20, "tail": 10},
    "weekly": {"window": 10, "tail": 8},
}
RETURN_PERIODS = {"1D": 1, "1W": 5, "1M": 21, "3M": 63}

QUADRANTS = ("Leading", "Weakening", "Lagging", "Improving")


def _cache_path() -> Path:
    from backend.config import DATA_DIR

    return DATA_DIR / "cache" / "sector_rotation.json"


def quadrant(ratio: float, momentum: float) -> str:
    if ratio >= 100:
        return "Leading" if momentum >= 100 else "Weakening"
    return "Improving" if momentum >= 100 else "Lagging"


def _zscore(series: pd.Series, window: int) -> pd.Series:
    mean = series.rolling(window).mean()
    std = series.rolling(window).std(ddof=0)
    return (series - mean) / std.replace(0, np.nan)


def _close_series(df: pd.DataFrame) -> pd.Series:
    s = pd.Series(df["close"].astype(float).values, index=pd.to_datetime(df["timestamp"]).dt.normalize())
    return s[~s.index.duplicated(keep="last")].sort_index()


def _to_weekly(close: pd.Series) -> pd.Series:
    # Last close of each week (week ending Friday)
    return close.resample("W-FRI").last().dropna()


def compute_rrg(sector_close: pd.Series, bench_close: pd.Series, *, window: int, tail: int) -> list[dict]:
    """Return the last `tail` RRG points [{t, ratio, momentum}] (oldest first)."""
    aligned = pd.concat([sector_close, bench_close], axis=1, join="inner").dropna()
    if len(aligned) < 2 * window + 2:
        return []
    rs = 100.0 * aligned.iloc[:, 0] / aligned.iloc[:, 1]
    # Light EMA smoothing keeps tails readable (raw 1-bar momentum is very noisy).
    rs = rs.ewm(span=max(2, window // 4), adjust=False).mean()
    ratio = 100.0 + _zscore(rs, window)
    roc = (ratio.pct_change(fill_method=None) * 100.0).ewm(span=3, adjust=False).mean()
    momentum = 100.0 + _zscore(roc, window)
    pts = pd.concat([ratio, momentum], axis=1, keys=["ratio", "momentum"]).dropna()
    pts = pts.iloc[-tail:]
    return [
        {"t": idx.strftime("%Y-%m-%d"), "ratio": round(float(r.ratio), 3), "momentum": round(float(r.momentum), 3)}
        for idx, r in pts.iterrows()
    ]


def heading(trail: list[dict]) -> dict:
    """Direction (degrees, 0 = east, 90 = north) and speed of the last move."""
    if len(trail) < 2:
        return {"angle": None, "speed": 0.0}
    a, b = trail[-2], trail[-1]
    dx, dy = b["ratio"] - a["ratio"], b["momentum"] - a["momentum"]
    return {"angle": round(math.degrees(math.atan2(dy, dx)), 1), "speed": round(math.hypot(dx, dy), 3)}


def returns(close: pd.Series) -> dict:
    out = {}
    for label, n in RETURN_PERIODS.items():
        if len(close) > n:
            prev = float(close.iloc[-n - 1])
            out[label] = round((float(close.iloc[-1]) / prev - 1.0) * 100.0, 2) if prev else None
        else:
            out[label] = None
    return out


def _flow_score(trail: list[dict]) -> float:
    """
    Positive = relative strength rotating toward the sector, negative = away.
    Uses the last move projected on the clockwise rotation path: gains in
    momentum count most, gains in ratio add to it.
    """
    if len(trail) < 2:
        return 0.0
    a, b = trail[-2], trail[-1]
    return round((b["momentum"] - a["momentum"]) + 0.5 * (b["ratio"] - a["ratio"]), 3)


def build_rotation(sector_frames: dict[str, pd.DataFrame], bench_frame: pd.DataFrame) -> dict:
    """Build the full rotation payload for every timeframe from daily OHLC frames."""
    bench_daily = _close_series(bench_frame)
    bench_weekly = _to_weekly(bench_daily)
    views: dict[str, list[dict]] = {tf: [] for tf in TIMEFRAMES}
    perf: list[dict] = []
    as_of = None

    for name, df in sector_frames.items():
        try:
            daily = _close_series(df)
        except Exception as e:  # malformed frame: skip sector, keep the rest
            logger.warning("Rotation: bad data for %s: %s", name, e)
            continue
        perf.append({"sector_name": name, "returns": returns(daily)})
        series = {"daily": (daily, bench_daily), "weekly": (_to_weekly(daily), bench_weekly)}
        for tf, cfg in TIMEFRAMES.items():
            trail = compute_rrg(*series[tf], window=cfg["window"], tail=cfg["tail"])
            if not trail:
                continue
            last = trail[-1]
            prev_q = quadrant(trail[-2]["ratio"], trail[-2]["momentum"]) if len(trail) > 1 else None
            q = quadrant(last["ratio"], last["momentum"])
            views[tf].append({
                "sector_name": name,
                "trail": trail,
                "quadrant": q,
                "previous_quadrant": prev_q,
                "heading": heading(trail),
                "flow": _flow_score(trail),
            })
            if tf == "daily":
                as_of = max(as_of or last["t"], last["t"])

    summary = {}
    for tf, rows in views.items():
        rows.sort(key=lambda r: r["flow"], reverse=True)
        summary[tf] = {q: sum(1 for r in rows if r["quadrant"] == q) for q in QUADRANTS}

    return {
        "available": bool(views["daily"] or views["weekly"]),
        "generated_at": datetime.now(IST).isoformat(timespec="seconds"),
        "as_of": as_of,
        "benchmark": "Nifty 50",
        "benchmark_close": round(float(bench_daily.iloc[-1]), 2) if len(bench_daily) else None,
        "benchmark_returns": returns(bench_daily),
        "timeframes": {tf: {**cfg, "sectors": views[tf], "quadrants": summary[tf]} for tf, cfg in TIMEFRAMES.items()},
        "performance": sorted(perf, key=lambda p: (p["returns"].get("1M") is None, -(p["returns"].get("1M") or 0))),
    }


def save_rotation(payload: dict, path: Optional[Path] = None) -> None:
    path = path or _cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"))
        os.replace(tmp, path)
    except Exception:
        Path(tmp).unlink(missing_ok=True)
        raise


def load_rotation(path: Optional[Path] = None) -> dict:
    path = path or _cache_path()
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {"available": False, "reason": "Run a sector refresh to compute rotation."}
    except Exception as e:
        logger.warning("Could not read sector rotation cache: %s", e)
        return {"available": False, "reason": "Rotation cache is unreadable; refresh sectors."}
