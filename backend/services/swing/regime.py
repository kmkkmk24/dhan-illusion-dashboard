"""
Market regime: the single biggest loss filter. Breakouts fail far more often when the
index is below its key averages and few stocks participate.

  Index (Nifty 50, 60 pts): above 21-EMA, 50-DMA, 200-DMA, 50 > 200, 50-DMA rising
  Breadth (40 pts): % of the swing universe above its 50-DMA, 52-week new highs vs lows

  >= 65  uptrend    full position size, A+ and A setups suggested
  45-65  caution    half size, only A+ setups suggested
  < 45   downtrend  no new entries suggested ("cash is a position"); watchlist only
"""

from __future__ import annotations

from typing import Optional

import pandas as pd

from backend.services.techno_funda_technical import ema, sma

LABELS = {"uptrend": 1.0, "caution": 0.5, "downtrend": 0.0}


def compute_regime(bench: Optional[pd.DataFrame], breadth: dict) -> dict:
    pts, notes = 0.0, []
    idx = {}
    if bench is not None and len(bench) >= 210:
        c = bench["close"].astype(float)
        last = float(c.iloc[-1])
        e21, s50, s200 = float(ema(c, 21).iloc[-1]), float(sma(c, 50).iloc[-1]), float(sma(c, 200).iloc[-1])
        s50_prev = float(sma(c, 50).iloc[-11])
        hi = float(bench["high"].tail(252).max())
        checks = [
            (last > e21, 10, "Nifty above 21-EMA"),
            (last > s50, 15, "Nifty above 50-DMA"),
            (last > s200, 15, "Nifty above 200-DMA"),
            (s50 > s200, 10, "50-DMA above 200-DMA"),
            (s50 > s50_prev, 10, "50-DMA rising"),
        ]
        for ok, w, label in checks:
            pts += w if ok else 0
            notes.append(("✓ " if ok else "✗ ") + label)
        dd = (last / hi - 1) * 100
        idx = {"close": round(last, 2), "ema21": round(e21, 2), "sma50": round(s50, 2), "sma200": round(s200, 2),
               "from_high_pct": round(dd, 1), "ret_1m": round((last / float(c.iloc[-22]) - 1) * 100, 1)}
    else:
        pts += 30
        notes.append("Index history unavailable: neutral assumption")
        dd = 0.0

    a50 = breadth.get("above50_pct")
    nh, nl = breadth.get("new_highs") or 0, breadth.get("new_lows") or 0
    if a50 is not None:
        pts += 25 * min(1.0, max(0.0, (a50 - 20) / 50))
        notes.append(f"{a50:.0f}% of stocks above their 50-DMA")
    if nh + nl:
        pts += 15 * nh / (nh + nl)
        notes.append(f"52-week highs {nh} vs lows {nl}")
    else:
        pts += 7.5

    score = round(pts, 1)
    label = "uptrend" if score >= 65 else "caution" if score >= 45 else "downtrend"
    if label == "uptrend" and dd < -10:
        label = "caution"
        notes.append("Index more than 10% below its high: capped at caution")
    return {"label": label, "score": score, "risk_mult": LABELS[label], "notes": notes, "index": idx,
            "breadth": breadth}
