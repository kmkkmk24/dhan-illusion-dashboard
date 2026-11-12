"""
Indicators shared by the swing setups: trend template, relative strength, volume /
delivery accumulation, and Smart Money Concepts (SMC) structure:

  * swing pivots (fractals) and market structure (higher highs / higher lows)
  * break of structure (BOS): a close above the last swing high
  * liquidity sweep ("spring" / shakeout): a low that undercuts a prior swing low
    and closes back above it, i.e. weak hands' stops were taken
  * bullish order block: the last down candle before the impulse that broke structure
  * fair value gaps (FVG): 3-candle imbalances left by displacement

All functions take a daily frame (timestamp, open, high, low, close, volume[, deliv_pct])
sorted oldest -> newest and are pure (no I/O).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
import pandas as pd

from backend.services.techno_funda_technical import atr, ema, sma


def _f(v) -> Optional[float]:
    try:
        x = float(v)
        return None if np.isnan(x) or np.isinf(x) else x
    except (TypeError, ValueError):
        return None


def pct(a: Optional[float], b: Optional[float]) -> Optional[float]:
    if a is None or b is None or not b:
        return None
    return (a / b - 1.0) * 100.0


def ret(close: pd.Series, bars: int) -> Optional[float]:
    if len(close) <= bars:
        return None
    base = float(close.iloc[-bars - 1])
    return (float(close.iloc[-1]) / base - 1.0) * 100.0 if base > 0 else None


def rs_raw(close: pd.Series) -> Optional[float]:
    """IBD-style weighted 12-month performance (latest quarter counts double)."""
    r3, r6, r9, r12 = ret(close, 63), ret(close, 126), ret(close, 189), ret(close, 252)
    if r3 is None:
        return None
    r6 = r6 if r6 is not None else r3
    r9 = r9 if r9 is not None else r6
    r12 = r12 if r12 is not None else r9
    return 0.4 * r3 + 0.2 * r6 + 0.2 * r9 + 0.2 * r12


def percentile_ranks(values: dict[str, Optional[float]]) -> dict[str, int]:
    """1..99 rank of each value across the universe (RS rating)."""
    items = [(k, v) for k, v in values.items() if v is not None]
    if not items:
        return {}
    s = pd.Series(dict(items))
    r = s.rank(pct=True, method="average")
    return {k: int(max(1, min(99, round(v * 99)))) for k, v in r.items()}


@dataclass
class Features:
    close: float
    atr: float
    atr_pct: float
    sma10: Optional[float]
    sma20: Optional[float]
    sma50: Optional[float]
    sma150: Optional[float]
    sma200: Optional[float]
    ema10: Optional[float]
    ema21: Optional[float]
    sma200_rising: bool
    sma50_rising: bool
    hi52: float
    lo52: float
    ath: float
    from_hi52_pct: float
    above_lo52_pct: float
    avg_vol50: float
    avg_turnover20: float
    vol_ratio_today: float
    up_down_vol: Optional[float]
    deliv_recent: Optional[float]
    deliv_base: Optional[float]
    rs_line_new_high: Optional[bool]
    mansfield_rs: Optional[float]
    ret_1m: Optional[float]
    ret_3m: Optional[float]
    template: dict
    bars: int


def features(df: pd.DataFrame, bench_close: Optional[pd.Series] = None) -> Features:
    c, v = df["close"], df["volume"]
    last = float(c.iloc[-1])
    a = atr(df, 14)
    atr_v = _f(a.iloc[-1]) or float((df["high"] - df["low"]).tail(14).mean())
    s50, s150, s200 = sma(c, 50), sma(c, 150), sma(c, 200)
    hi52 = float(df["high"].tail(252).max())
    lo52 = float(df["low"].tail(252).min())
    avg_vol50 = float(v.tail(50).mean()) or 1.0
    turnover = (c * v).tail(20).mean()

    up = v.where(c.diff() > 0, 0).tail(50).sum()
    dn = v.where(c.diff() < 0, 0).tail(50).sum()
    udv = float(up / dn) if dn > 0 else None

    deliv_recent = deliv_base = None
    if "deliv_pct" in df.columns:
        d = df["deliv_pct"]
        if d.tail(10).notna().sum() >= 5:
            deliv_recent = float(d.tail(10).mean())
        if d.tail(60).notna().sum() >= 15:
            deliv_base = float(d.tail(60).mean())

    rs_new_high = mansfield = None
    if bench_close is not None and len(bench_close):
        b = bench_close.reindex(df["timestamp"]).ffill().values
        ratio = pd.Series(c.values / b, index=df.index).replace([np.inf, -np.inf], np.nan)
        if ratio.tail(63).notna().sum() > 40:
            rs_new_high = bool(ratio.iloc[-1] >= ratio.tail(63).max() * 0.995)
        base = ratio.rolling(250, min_periods=120).mean().iloc[-1]
        mansfield = _f((ratio.iloc[-1] / base - 1) * 100) if base and not np.isnan(base) else None

    s200_v, s50_v, s150_v = _f(s200.iloc[-1]), _f(s50.iloc[-1]), _f(s150.iloc[-1])
    s200_prev = _f(s200.iloc[-22]) if len(s200) > 22 else None
    s50_prev = _f(s50.iloc[-6]) if len(s50) > 6 else None
    tpl = {
        "price_above_150_200": bool(s150_v and s200_v and last > s150_v and last > s200_v),
        "sma150_above_200": bool(s150_v and s200_v and s150_v > s200_v),
        "sma200_rising_1m": bool(s200_v and s200_prev and s200_v > s200_prev),
        "sma50_above_150_200": bool(s50_v and s150_v and s200_v and s50_v > s150_v and s50_v > s200_v),
        "price_above_50": bool(s50_v and last > s50_v),
        "30pct_above_52w_low": bool(lo52 > 0 and last >= lo52 * 1.30),
        "within_25pct_of_52w_high": bool(hi52 > 0 and last >= hi52 * 0.75),
    }
    return Features(
        close=last, atr=atr_v, atr_pct=atr_v / last * 100 if last else 0.0,
        sma10=_f(sma(c, 10).iloc[-1]), sma20=_f(sma(c, 20).iloc[-1]), sma50=s50_v, sma150=s150_v, sma200=s200_v,
        ema10=_f(ema(c, 10).iloc[-1]), ema21=_f(ema(c, 21).iloc[-1]),
        sma200_rising=bool(s200_v and s200_prev and s200_v > s200_prev),
        sma50_rising=bool(s50_v and s50_prev and s50_v > s50_prev),
        hi52=hi52, lo52=lo52, ath=float(df["high"].max()),
        from_hi52_pct=(last / hi52 - 1) * 100 if hi52 else 0.0,
        above_lo52_pct=(last / lo52 - 1) * 100 if lo52 else 0.0,
        avg_vol50=avg_vol50, avg_turnover20=float(turnover) if pd.notna(turnover) else 0.0,
        vol_ratio_today=float(v.iloc[-1]) / avg_vol50,
        up_down_vol=udv, deliv_recent=deliv_recent, deliv_base=deliv_base,
        rs_line_new_high=rs_new_high, mansfield_rs=mansfield,
        ret_1m=ret(c, 21), ret_3m=ret(c, 63), template=tpl, bars=len(df),
    )


# ── SMC structure ─────────────────────────────────────────────────────────

def pivots(df: pd.DataFrame, k: int = 3) -> tuple[list[int], list[int]]:
    """Indices of fractal swing highs / lows (k bars each side; the last k bars cannot qualify)."""
    h, l = df["high"].values, df["low"].values
    highs, lows = [], []
    for i in range(k, len(df) - k):
        if h[i] >= h[i - k:i + k + 1].max():
            highs.append(i)
        if l[i] <= l[i - k:i + k + 1].min():
            lows.append(i)
    return highs, lows


def zigzag(df: pd.DataFrame, start: int, threshold_pct: float) -> list[tuple[int, str, float]]:
    """
    Alternating swing points (index, 'H'|'L', price) from `start`, reversing only after a
    move of at least threshold_pct. Used to measure VCP contractions.
    """
    h, l = df["high"].values, df["low"].values
    if start >= len(df) - 1:
        return []
    pts: list[list] = [[start, "H", float(h[start])]]
    for i in range(start + 1, len(df)):
        kind, price = pts[-1][1], pts[-1][2]
        if kind == "H":
            if h[i] >= price:
                pts[-1] = [i, "H", float(h[i])]
            elif (price - l[i]) / price * 100 >= threshold_pct:
                pts.append([i, "L", float(l[i])])
        else:
            if l[i] <= price:
                pts[-1] = [i, "L", float(l[i])]
            elif (h[i] - price) / price * 100 >= threshold_pct:
                pts.append([i, "H", float(h[i])])
    return [tuple(p) for p in pts]


def liquidity_sweep(df: pd.DataFrame, lookback: int = 20, ref: int = 40) -> Optional[dict]:
    """
    A bar in the last `lookback` bars whose low pierced the lowest swing low of the
    preceding `ref` bars but closed back above it (stop-run / spring).
    """
    n = len(df)
    if n < lookback + ref + 5:
        return None
    lo, cl = df["low"].values, df["close"].values
    for i in range(n - 1, n - lookback - 1, -1):
        window = lo[max(0, i - ref):i - 2]
        if not len(window):
            continue
        level = window.min()
        if lo[i] < level and cl[i] > level:
            return {"index": i, "level": float(level), "low": float(lo[i]), "bars_ago": n - 1 - i}
    return None


def fair_value_gaps(df: pd.DataFrame, since: int, min_gap_pct: float = 0.3) -> list[dict]:
    """Bullish FVGs (low[i] > high[i-2]) created after `since` and not yet filled by a later close."""
    h, l, c = df["high"].values, df["low"].values, df["close"].values
    out = []
    for i in range(max(2, since), len(df)):
        if l[i] > h[i - 2] and (l[i] - h[i - 2]) / h[i - 2] * 100 >= min_gap_pct:
            top, bottom = float(l[i]), float(h[i - 2])
            filled = bool((c[i + 1:] < bottom).any()) if i + 1 < len(df) else False
            out.append({"index": i, "top": top, "bottom": bottom, "filled": filled})
    return out


def bullish_order_block(df: pd.DataFrame, impulse_start: int) -> Optional[dict]:
    """Last bearish candle at or before the impulse start (institutional demand zone)."""
    o, c, h, l = df["open"].values, df["close"].values, df["high"].values, df["low"].values
    for i in range(min(impulse_start, len(df) - 1), max(-1, impulse_start - 8), -1):
        if c[i] < o[i]:
            return {"index": i, "high": float(h[i]), "low": float(l[i])}
    return None


def structure(df: pd.DataFrame, k: int = 3) -> dict:
    """Market structure from the last two swing highs and lows."""
    hi, lo = pivots(df, k)
    h, l, c = df["high"].values, df["low"].values, df["close"].values
    hh = len(hi) >= 2 and h[hi[-1]] > h[hi[-2]]
    hl = len(lo) >= 2 and l[lo[-1]] > l[lo[-2]]
    last_sh = float(h[hi[-1]]) if hi else None
    bos = bool(last_sh and c[-1] > last_sh)
    return {"higher_high": bool(hh), "higher_low": bool(hl), "bullish": bool(hh and hl),
            "last_swing_high": last_sh, "last_swing_low": float(l[lo[-1]]) if lo else None,
            "bos": bos, "swing_highs": hi, "swing_lows": lo}


def overhead_resistance(df: pd.DataFrame, price: float, k: int = 5) -> Optional[float]:
    """Nearest prior swing high above `price` (supply / buy-side liquidity), None at all-time highs."""
    hi, _ = pivots(df.iloc[:-5] if len(df) > 30 else df, k)
    levels = sorted(float(df["high"].iloc[i]) for i in hi if float(df["high"].iloc[i]) > price * 1.01)
    return levels[0] if levels else None


def volume_dryup(df: pd.DataFrame, avg_vol50: float, bars: int = 10) -> dict:
    v = df["volume"].tail(bars)
    ratio = float(v.mean()) / avg_vol50 if avg_vol50 else 1.0
    pockets = int((v < 0.5 * avg_vol50).sum())
    return {"ratio": ratio, "quiet_days": pockets}
