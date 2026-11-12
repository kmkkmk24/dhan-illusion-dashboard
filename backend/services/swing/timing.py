"""
How long a swing trade might take to reach T1 / T2: a block-bootstrap simulation on the
stock's OWN last year of daily moves.

Each simulated day re-uses a real day's close-to-close change and its high / low range
(relative to the previous close), sampled in blocks of 5 consecutive days so momentum and
volatility clusters survive. Starting at the entry, every path is followed for up to
`horizon` sessions and the first touch of the stop, T1 and T2 is recorded (a day that
touches both the stop and a target counts as the stop: conservative).

Bias guard: a stock that qualifies for a setup usually had a strong year, so replaying its
returns as-is would promise targets too fast. The average daily drift is halved before
simulating. Results are estimates, not promises; they are seeded so the same data always
gives the same answer.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

PATHS = 2000
HORIZON = 60
BLOCK = 5
LOOKBACK = 250
DRIFT_KEEP = 0.5


def _seed(*vals: float) -> int:
    return int(abs(hash(tuple(round(float(v), 2) for v in vals))) % (2 ** 32))


def estimate_days(df: pd.DataFrame, entry: float, stop: float, t1: float, t2: float, *,
                  paths: int = PATHS, horizon: int = HORIZON) -> Optional[dict]:
    """
    Returns {t1: {median, p25, p75, prob}, t2: {...}, stop_prob, horizon, sample_days} or None.
    Days are trading sessions after the entry fills; prob = chance the target is touched
    before the stop within the horizon.
    """
    if df is None or len(df) < 60 or not (0 < stop < entry < t1 <= t2):
        return None
    d = df.tail(LOOKBACK + 1)
    prev = d["close"].shift(1)
    r = (d["close"] / prev).iloc[1:].to_numpy(dtype=float)
    hi = (d["high"] / prev).iloc[1:].to_numpy(dtype=float)
    lo = (d["low"] / prev).iloc[1:].to_numpy(dtype=float)
    ok = np.isfinite(r) & np.isfinite(hi) & np.isfinite(lo) & (r > 0)
    r, hi, lo = r[ok], hi[ok], lo[ok]
    n = len(r)
    if n < 40:
        return None
    # halve the drift: shift log-returns (and the day's range with them) by half the mean
    shift = np.exp(-(1 - DRIFT_KEEP) * np.log(r).mean())
    r, hi, lo = r * shift, hi * shift, lo * shift

    rng = np.random.default_rng(_seed(entry, stop, t1, t2, n))
    blocks = int(np.ceil(horizon / BLOCK))
    starts = rng.integers(0, n - BLOCK + 1, size=(paths, blocks))
    idx = (starts[:, :, None] + np.arange(BLOCK)).reshape(paths, -1)[:, :horizon]
    rr, hh, ll = r[idx], hi[idx], lo[idx]

    prev_close = entry * np.cumprod(np.concatenate([np.ones((paths, 1)), rr[:, :-1]], axis=1), axis=1)
    day_hi, day_lo = prev_close * hh, prev_close * ll

    def first(mask: np.ndarray) -> np.ndarray:
        hit = mask.any(axis=1)
        day = np.where(hit, mask.argmax(axis=1) + 1, horizon + 1)
        return day

    d_stop = first(day_lo <= stop)
    out: dict = {"horizon": horizon, "paths": paths, "sample_days": int(n),
                 "stop_prob": round(float((d_stop <= horizon).mean()) * 100, 1)}
    for name, level in (("t1", t1), ("t2", t2)):
        d_t = first(day_hi >= level)
        won = d_t < d_stop                       # same-day touch of both = stop (strict)
        won &= d_t <= horizon
        days = d_t[won]
        out[name] = {
            "prob": round(float(won.mean()) * 100, 1),
            "median": int(np.median(days)) if len(days) else None,
            "p25": int(np.percentile(days, 25)) if len(days) else None,
            "p75": int(np.percentile(days, 75)) if len(days) else None,
        }
    return out
