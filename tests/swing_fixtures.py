"""Synthetic daily candles shaped like each swing setup (deterministic, no network)."""

from datetime import date, timedelta

import numpy as np
import pandas as pd


END = date(2026, 11, 11)     # a Wednesday; 10 Nov 2026 is an NSE holiday


def sessions(n, end=END):
    from backend.services.market_calendar import is_trading_day

    days, d = [], end
    while len(days) < n:
        if is_trading_day(d):
            days.append(d)
        d -= timedelta(days=1)
    return days[::-1]


def frame(closes, *, end=END, vol=None, spread=0.012, deliv=None):
    closes = np.asarray(closes, dtype=float)
    n = len(closes)
    days = sessions(n, end)
    opens = np.r_[closes[0], closes[:-1]]
    hi = np.maximum(opens, closes) * (1 + spread / 2)
    lo = np.minimum(opens, closes) * (1 - spread / 2)
    v = np.full(n, 100_000.0) if vol is None else np.asarray(vol, dtype=float)
    df = pd.DataFrame({"timestamp": pd.to_datetime(days), "open": opens, "high": hi, "low": lo,
                       "close": closes, "volume": v})
    df["deliv_pct"] = np.nan if deliv is None else deliv
    return df


def _path(points):
    """Piecewise-linear path through (bars, price) waypoints."""
    out = [points[0][1]]
    for (_, a), (n, b) in zip(points, points[1:]):
        out.extend(np.linspace(a, b, n + 1)[1:])
    return np.array(out)


def vcp_frame():
    # 260-bar advance 100 -> 300, then a base: 300 -> 250 (17%), 290 -> 266 (8%), 287 -> 278 (3%), close near 286
    up = _path([(0, 100), (260, 300)])
    base = _path([(0, 300), (14, 250), (14, 290), (8, 266), (10, 287), (5, 278), (6, 285.5)])[1:]
    closes = np.r_[up, base]
    vol = np.full(len(closes), 200_000.0)
    vol[-12:] = 90_000.0          # dry-up in the last contraction
    return frame(closes, vol=vol, spread=0.01)


def flag_frame():
    up = _path([(0, 100), (200, 150), (40, 160)])
    pole = _path([(0, 160), (8, 205)])[1:]
    flg = _path([(0, 205), (6, 194), (2, 198)])[1:]
    closes = np.r_[up, pole, flg]
    vol = np.full(len(closes), 100_000.0)
    vol[len(up):len(up) + len(pole)] = 260_000.0
    vol[-len(flg):] = 70_000.0
    return frame(closes, vol=vol, spread=0.01)


def ipo_frame():
    # listed 70 sessions ago: run-up to ATH 400 at bar 20, base to 330, tight near 392
    closes = _path([(0, 300), (20, 400), (15, 330), (20, 385), (10, 372), (5, 392)])
    vol = np.full(len(closes), 300_000.0)
    vol[-10:] = 150_000.0
    return frame(closes, vol=vol, spread=0.01)


def downtrend_frame():
    return frame(_path([(0, 300), (300, 150)]))
