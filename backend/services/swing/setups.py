"""
The three swing setups. Each detector looks at one stock's daily frame and returns a
candidate (or None) with:

  pattern_q   0..1 quality of the pattern itself (the engine adds trend, RS, sector,
              smart-money and risk components to make the final 0..100 score)
  status      triggered | ready | forming | extended
  entry       buy-stop just above the pivot (never chase: > max_chase% above = extended)
  stop        structural stop (last contraction / flag / base low, SMC sweep low),
              widened to >= 1 ATR to avoid noise, rejected when wider than max_risk%
  target1/2   2R (partial booking) and the pattern target (3R / measured move)
  reasons / warnings, levels for the chart

Design rules that keep losses small:
  * entries are only ever at a breakout of a tight area, with the stop just below it
  * a stop wider than max_risk_pct makes the setup "wide" (never a top pick)
  * extended breakouts are flagged instead of suggested
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd

from backend.services.swing import indicators as ind


@dataclass
class SetupParams:
    max_risk_pct: float = 8.0
    min_risk_atr: float = 1.0          # stop at least 1 ATR below entry
    ready_pct: float = 3.0              # within 3% below the pivot = ready
    forming_pct: float = 10.0           # 3..10% below = forming (watchlist)
    max_chase_pct: float = 4.0          # more than 4% above entry = extended
    entry_buffer_pct: float = 0.2
    breakout_vol_ratio: float = 1.4
    # VCP
    vcp_max_base_bars: int = 130
    vcp_min_base_bars: int = 15
    vcp_max_depth_pct: float = 40.0
    vcp_max_final_pct: float = 12.0
    vcp_max_contractions: int = 6
    vcp_min_template: int = 6           # of the 7 trend-template checks
    vcp_max_dryup: float = 0.95         # last-10-day volume vs 50-day average
    vcp_max_atr_ratio: float = 1.0      # last-10-day range vs 50-day range
    # Flag
    flag_min_pole_pct: float = 15.0
    flag_max_pole_bars: int = 20
    flag_min_bars: int = 4
    flag_max_vol_vs_pole: float = 0.8   # flag volume must contract vs the pole
    flag_max_tight5_pct: float = 12.0
    flag_max_bars: int = 15
    flag_max_retrace: float = 0.5
    # IPO
    ipo_max_age_days: int = 730
    ipo_min_bars: int = 12
    ipo_max_depth_pct: float = 40.0
    ipo_max_risk_pct: float = 9.0
    ipo_ready_pct: float = 5.0
    ipo_watch_risk_mult: float = 2.5    # wide IPO bases stay visible (never top picks)


@dataclass
class Candidate:
    setup: str
    status: str
    entry: float
    stop: float
    target1: float
    target2: float
    risk_pct: float
    pattern_q: float
    reasons: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    levels: dict = field(default_factory=dict)
    metrics: dict = field(default_factory=dict)
    wide: bool = False
    smc: dict = field(default_factory=dict)


def tick(x: float) -> float:
    return round(round(float(x) / 0.05) * 0.05, 2)


def _band(x: float, steps: list[tuple[float, float]], default: float) -> float:
    """First score whose threshold x is <= (steps sorted ascending by threshold)."""
    for thr, score in steps:
        if x <= thr:
            return score
    return default


def classify(close: float, entry: float, today_high: float, vol_ratio: float, p: SetupParams,
             ready_pct: Optional[float] = None) -> str:
    ready = ready_pct if ready_pct is not None else p.ready_pct
    if close >= entry:
        return "extended" if close > entry * (1 + p.max_chase_pct / 100) else "triggered"
    dist = (entry / close - 1) * 100
    if dist <= ready:
        return "ready"
    if dist <= p.forming_pct:
        return "forming"
    return ""


def upthrust(status: str, today_high: float, entry: float) -> Optional[str]:
    if status in ("ready", "forming") and today_high >= entry:
        return "Today's high broke the pivot but the close fell back (upthrust): wait for a clean close above"
    return None


def make_plan(entry: float, struct_stop: float, atr: float, max_risk: float, p: SetupParams,
              target_hint: Optional[float] = None, alt_stop: Optional[float] = None) -> dict:
    """Stop/targets for a long entry. Returns dict incl. 'wide' when risk > max_risk."""
    stop = struct_stop - 0.1 * atr
    if entry - stop < p.min_risk_atr * atr:            # too tight -> noise stop-outs
        stop = entry - p.min_risk_atr * atr
    risk_pct = (entry - stop) / entry * 100
    if risk_pct > max_risk and alt_stop is not None:  # try the tighter structure
        s2 = min(alt_stop - 0.1 * atr, entry - p.min_risk_atr * atr)
        if (entry - s2) / entry * 100 <= max_risk:
            stop, risk_pct = s2, (entry - s2) / entry * 100
    stop = tick(stop)
    r = entry - stop
    t1 = entry + 2 * r
    t2 = max(entry + 3 * r, target_hint or 0)
    return {"stop": stop, "risk_pct": round(risk_pct, 2), "target1": tick(t1), "target2": tick(t2),
            "wide": risk_pct > max_risk, "max_risk": max_risk}


def _smc_common(df: pd.DataFrame, since: int) -> dict:
    sweep = ind.liquidity_sweep(df, lookback=min(20, max(5, len(df) - since)))
    st = ind.structure(df.tail(160).reset_index(drop=True))
    return {"sweep": sweep, "structure_bullish": st["bullish"], "higher_low": st["higher_low"]}


# ── VCP ───────────────────────────────────────────────────────────────────

def detect_vcp(df: pd.DataFrame, f: ind.Features, p: SetupParams) -> Optional[Candidate]:
    today_high = float(df["high"].iloc[-1])
    df = df.iloc[:-1].reset_index(drop=True)   # structure up to yesterday; today tests the breakout
    n = len(df)
    if n < 200 or not f.sma50 or not f.sma200:
        return None
    # Stage 2 gates (Minervini trend template core)
    if not (f.close > f.sma200 and f.sma50 > f.sma200 and f.close >= f.hi52 * 0.75 and f.sma200_rising):
        return None
    h, l = df["high"].values, df["low"].values
    lo_i = max(0, n - p.vcp_max_base_bars)
    start = lo_i + int(np.argmax(h[lo_i:n - 3]))
    base_high = float(h[start])
    base_len = n - 1 - start
    if base_len < p.vcp_min_base_bars:
        return None
    base_low = float(l[start:].min())
    depth = (base_high - base_low) / base_high * 100
    if depth > p.vcp_max_depth_pct or depth < 4:
        return None

    if sum(f.template.values()) < p.vcp_min_template:
        return None
    thr = max(4.0, 2.0 * f.atr_pct)     # only real pullbacks count as contractions, not daily noise
    pts = ind.zigzag(df, start, thr)
    depths, last_h_idx = [], start
    for a, b in zip(pts, pts[1:]):
        if a[1] == "H" and b[1] == "L":
            depths.append((a[2] - b[2]) / a[2] * 100)
            last_h_idx = a[0]
    # Current tight area counts as the final contraction when it is tighter than the last leg.
    recent = df.tail(10)
    tight = float((recent["high"].max() - recent["low"].min()) / recent["high"].max() * 100)
    if depths and tight < depths[-1] * 0.8:
        depths.append(tight)
        last_h_idx = n - 10 + int(np.argmax(recent["high"].values))
    if not 2 <= len(depths) <= p.vcp_max_contractions:
        return None
    final = depths[-1]
    if final > p.vcp_max_final_pct or depths[0] > p.vcp_max_depth_pct:
        return None
    # Minervini: the first pullback is the deepest, the last the tightest, and they shrink in between.
    if depths[0] < 0.9 * max(depths) or final > 1.1 * min(depths) or final > 0.6 * depths[0]:
        return None
    decreasing = sum(1 for a, b in zip(depths, depths[1:]) if b <= a * 1.1) / (len(depths) - 1)
    if decreasing < 0.6:
        return None

    pivot = float(h[last_h_idx:].max())
    if pivot < base_high * 0.85:            # right side of the base has not recovered yet
        return None
    final_low = float(l[last_h_idx:].min())
    entry = tick(pivot * (1 + p.entry_buffer_pct / 100))
    tight5 = float(df["low"].tail(5).min())
    plan = make_plan(entry, final_low, f.atr, p.max_risk_pct, p, alt_stop=tight5)
    if plan["risk_pct"] > 1.5 * plan["max_risk"]:
        return None                          # no sensible stop: cannot be sized

    a10 = float((df["high"] - df["low"]).tail(10).mean())
    a50 = float((df["high"] - df["low"]).tail(50).mean()) or a10
    dry = ind.volume_dryup(df, f.avg_vol50)
    if dry["ratio"] > p.vcp_max_dryup or a10 / a50 > p.vcp_max_atr_ratio:
        return None                         # no supply exhaustion: volume / range not contracting
    smc = _smc_common(df, start)
    q = np.mean([
        {2: 0.6, 3: 0.9}.get(len(depths), 1.0),
        decreasing,
        _band(final, [(5, 1.0), (8, 0.8), (12, 0.55)], 0.2),
        min(1.0, _band(dry["ratio"], [(0.6, 1.0), (0.75, 0.8), (0.9, 0.55)], 0.25) + (0.1 if dry["quiet_days"] >= 2 else 0)),
        _band(depth, [(20, 1.0), (30, 0.8), (40, 0.5)], 0.3),
        _band(a10 / a50, [(0.7, 1.0), (0.85, 0.7)], 0.4),
    ])
    status = classify(f.close, entry, today_high, f.vol_ratio_today, p)
    if plan["wide"] and status == "ready":
        status = "forming"                   # not actionable until the stop can be tight
    if not status:
        return None
    reasons = [
        f"{len(depths)} contractions: " + " → ".join(f"{d:.0f}%" for d in depths),
        f"Base {base_len} days, {depth:.0f}% deep; pivot ₹{pivot:,.2f}",
    ]
    if dry["ratio"] <= 0.75:
        reasons.append(f"Volume dried up to {dry['ratio'] * 100:.0f}% of average (sellers exhausted)")
    if smc["sweep"]:
        reasons.append(f"Liquidity sweep {smc['sweep']['bars_ago']}d ago below ₹{smc['sweep']['level']:,.2f} and reclaimed (shakeout)")
    warnings = [w for w in [upthrust(status, today_high, entry)] if w]
    if f.close < (f.sma50 or 0):
        warnings.append("Price is below the 50-DMA")
    if plan["wide"]:
        warnings.append(f"Stop is {plan['risk_pct']:.1f}% away (max {p.max_risk_pct:.0f}%): wait for a tighter area")
    if status == "triggered" and f.vol_ratio_today < p.breakout_vol_ratio:
        warnings.append(f"Breakout volume only {f.vol_ratio_today:.1f}× average (want ≥{p.breakout_vol_ratio}×)")
    return Candidate(
        setup="VCP", status=status, entry=entry, stop=plan["stop"], target1=plan["target1"], target2=plan["target2"],
        risk_pct=plan["risk_pct"], pattern_q=float(q), reasons=reasons, warnings=warnings, wide=plan["wide"],
        levels={"pivot": round(pivot, 2), "base_high": round(base_high, 2), "base_low": round(base_low, 2),
                "base_start": str(df["timestamp"].iloc[start].date())},
        metrics={"contractions": [round(d, 1) for d in depths], "base_days": base_len, "depth_pct": round(depth, 1),
                 "final_pct": round(final, 1), "dryup": round(dry["ratio"], 2), "atr_contraction": round(a10 / a50, 2)},
        smc={"sweep": bool(smc["sweep"]), "structure_bullish": smc["structure_bullish"]},
    )


# ── Flag ──────────────────────────────────────────────────────────────────

def detect_flag(df: pd.DataFrame, f: ind.Features, p: SetupParams) -> Optional[Candidate]:
    today_high = float(df["high"].iloc[-1])
    df = df.iloc[:-1].reset_index(drop=True)   # structure up to yesterday; today tests the breakout
    n = len(df)
    if n < 60:
        return None
    h, l, v = df["high"].values, df["low"].values, df["volume"].values
    win_lo = max(0, n - p.flag_max_bars - 1)
    pole_hi = win_lo + int(np.argmax(h[win_lo:n - p.flag_min_bars]))
    flag_len = n - 1 - pole_hi
    if not (p.flag_min_bars <= flag_len <= p.flag_max_bars):
        return None
    s_lo = max(0, pole_hi - p.flag_max_pole_bars)
    if pole_hi - s_lo < 3:
        return None
    pole_start = s_lo + int(np.argmin(l[s_lo:pole_hi]))
    H, L = float(h[pole_hi]), float(l[pole_start])
    pole_bars = pole_hi - pole_start
    gain = (H / L - 1) * 100
    if pole_bars < 2 or gain < p.flag_min_pole_pct or gain / pole_bars < 0.9:
        return None
    if H < float(h[max(0, pole_start - 60):pole_start + 1].max()) * 0.97:
        return None                              # pole did not reach prior highs: not a breakout leg
    flag_low = float(l[pole_hi + 1:].min())
    retrace = (H - flag_low) / (H - L)
    if retrace > p.flag_max_retrace:
        return None
    if f.sma50 and (f.close < f.sma50 or not f.sma50_rising):
        return None
    if f.ema21 and flag_low < f.ema21 * 0.97:
        return None

    k = min(5, flag_len)
    entry = tick(float(h[-k:].max()) * (1 + p.entry_buffer_pct / 100))
    pole_height = H - L
    plan = make_plan(entry, flag_low, f.atr, p.max_risk_pct, p,
                     target_hint=entry + 0.8 * pole_height, alt_stop=float(l[-k:].min()))
    if plan["risk_pct"] > 1.5 * plan["max_risk"]:
        return None                          # no sensible stop: cannot be sized
    vol_pole = float(v[pole_start:pole_hi + 1].mean())
    vol_flag = float(v[pole_hi + 1:].mean())
    pre_vol = float(v[max(0, pole_start - 50):pole_start].mean()) if pole_start > 5 else f.avg_vol50
    fvgs = ind.fair_value_gaps(df, pole_start)
    pole_fvgs = [g for g in fvgs if g["index"] <= pole_hi]
    unfilled = [g for g in pole_fvgs if not g["filled"]]
    prior_high = float(h[max(0, pole_start - 120):pole_start].max()) if pole_start > 5 else H
    bos = H > prior_high
    tight5 = float((df["high"].tail(5).max() - df["low"].tail(5).min()) / df["high"].tail(5).max() * 100)
    ob = ind.bullish_order_block(df, pole_start)
    if not bos:
        return None                          # pole stayed inside the old range: a bounce, not a breakout leg
    if (vol_pole and vol_flag / vol_pole > p.flag_max_vol_vs_pole) or tight5 > p.flag_max_tight5_pct:
        return None                          # distribution inside the flag / too loose to buy with a tight stop
    q = np.mean([
        _band(-gain, [(-40, 1.0), (-25, 0.8)], 0.55),
        _band(retrace, [(0.25, 1.0), (0.382, 0.85), (0.5, 0.6)], 0.3),
        _band(tight5, [(4, 1.0), (7, 0.75), (10, 0.5)], 0.2),
        _band(vol_flag / vol_pole if vol_pole else 1, [(0.5, 1.0), (0.75, 0.75)], 0.35),
        1.0 if vol_pole >= 1.3 * pre_vol else 0.55,
        1.0 if unfilled else (0.7 if pole_fvgs else 0.45),
        1.0 if bos else 0.4,
    ])
    status = classify(f.close, entry, today_high, f.vol_ratio_today, p)
    if plan["wide"] and status == "ready":
        status = "forming"                   # not actionable until the stop can be tight
    if not status:
        return None
    reasons = [
        f"Pole +{gain:.0f}% in {pole_bars} days on {vol_pole / pre_vol if pre_vol else 0:.1f}× volume",
        f"Flag {flag_len} days, gave back {retrace * 100:.0f}% of the pole; last 5 days {tight5:.1f}% range",
    ]
    if unfilled:
        reasons.append(f"{len(unfilled)} unfilled fair-value gap(s) in the pole: institutional displacement")
    if bos:
        reasons.append("Pole broke the prior swing high (bullish break of structure)")
    if vol_flag < 0.75 * vol_pole:
        reasons.append("Volume contracting inside the flag (no distribution)")
    warnings = [w for w in [upthrust(status, today_high, entry)] if w]
    if plan["wide"]:
        warnings.append(f"Stop is {plan['risk_pct']:.1f}% away (max {p.max_risk_pct:.0f}%)")
    if status == "triggered" and f.vol_ratio_today < p.breakout_vol_ratio:
        warnings.append(f"Breakout volume only {f.vol_ratio_today:.1f}× average")
    return Candidate(
        setup="FLAG", status=status, entry=entry, stop=plan["stop"], target1=plan["target1"], target2=plan["target2"],
        risk_pct=plan["risk_pct"], pattern_q=float(q), reasons=reasons, warnings=warnings, wide=plan["wide"],
        levels={"pole_low": round(L, 2), "pole_high": round(H, 2), "flag_low": round(flag_low, 2),
                "pole_start": str(df["timestamp"].iloc[pole_start].date()),
                "order_block": ob and {"low": round(ob["low"], 2), "high": round(ob["high"], 2)},
                "fvgs": [{"top": round(g["top"], 2), "bottom": round(g["bottom"], 2)} for g in unfilled[:3]]},
        metrics={"pole_pct": round(gain, 1), "pole_days": pole_bars, "flag_days": flag_len,
                 "retrace_pct": round(retrace * 100, 1), "tight5_pct": round(tight5, 1),
                 "flag_vol_vs_pole": round(vol_flag / vol_pole, 2) if vol_pole else None},
        smc={"bos": bos, "fvg": bool(unfilled), "order_block": bool(ob)},
    )


# ── IPO base ──────────────────────────────────────────────────────────────

def detect_ipo(df: pd.DataFrame, f: ind.Features, p: SetupParams, *, listing_age_days: Optional[int],
               issue_price: Optional[float] = None) -> Optional[Candidate]:
    today_high = float(df["high"].iloc[-1])
    df = df.iloc[:-1].reset_index(drop=True)   # structure up to yesterday; today tests the breakout
    n = len(df)
    if listing_age_days is None or listing_age_days > p.ipo_max_age_days or n < p.ipo_min_bars:
        return None
    h, l = df["high"].values, df["low"].values
    ath_i = int(np.argmax(h))
    ath = float(h[ath_i])
    base_len = n - 1 - ath_i
    if base_len < 8:
        return None
    base_low = float(l[ath_i:].min())
    depth = (ath - base_low) / ath * 100
    if depth > p.ipo_max_depth_pct or depth < 5:
        return None
    if issue_price and f.close < issue_price:
        return None
    recent = df.tail(10)
    tight = float((recent["high"].max() - recent["low"].min()) / recent["high"].max() * 100)
    if tight > 18:
        return None
    entry = tick(ath * (1 + p.entry_buffer_pct / 100))
    plan = make_plan(entry, float(recent["low"].min()), f.atr, p.ipo_max_risk_pct, p,
                     alt_stop=float(df["low"].tail(5).min()))
    if plan["risk_pct"] > p.ipo_watch_risk_mult * plan["max_risk"]:
        return None                          # young stocks: keep wider bases on the watchlist only
    dry = ind.volume_dryup(df, float(df["volume"].tail(min(50, n)).mean()))
    smc = _smc_common(df, ath_i)
    e21 = f.ema21
    since_issue = ind.pct(f.close, issue_price) if issue_price else None
    q = np.mean([
        _band(depth, [(20, 1.0), (30, 0.75), (40, 0.45)], 0.3),
        1.0 if base_len >= 15 else 0.6,
        _band(tight, [(6, 1.0), (10, 0.75), (14, 0.5)], 0.25),
        _band(dry["ratio"], [(0.6, 1.0), (0.8, 0.75)], 0.4),
        (1.0 if since_issue >= 50 else 0.8 if since_issue >= 20 else 0.6) if since_issue is not None else 0.6,
        1.0 if (e21 and f.close > e21) else 0.4,
    ])
    status = classify(f.close, entry, today_high, f.vol_ratio_today, p, ready_pct=p.ipo_ready_pct)
    if plan["wide"] and status == "ready":
        status = "forming"                   # not actionable until the stop can be tight
    if not status:
        return None
    reasons = [
        f"IPO listed {listing_age_days} days ago; base {base_len} days, {depth:.0f}% deep below the post-listing high ₹{ath:,.2f}",
        f"Last 10 days range {tight:.1f}%: buy the break to new all-time highs (no overhead supply)",
    ]
    if since_issue is not None:
        reasons.append(f"{since_issue:+.0f}% vs issue price ₹{issue_price:,.0f}")
    if dry["ratio"] <= 0.8:
        reasons.append(f"Volume dried up to {dry['ratio'] * 100:.0f}% of average")
    if smc["sweep"]:
        reasons.append("Liquidity sweep of the base low was reclaimed (shakeout)")
    warnings = [w for w in [upthrust(status, today_high, entry)] if w]
    if n < 200:
        warnings.append("Young stock: fewer than 200 days of history, higher volatility")
    if plan["wide"]:
        warnings.append(f"Stop is {plan['risk_pct']:.1f}% away (max {p.ipo_max_risk_pct:.0f}%)")
    return Candidate(
        setup="IPO", status=status, entry=entry, stop=plan["stop"], target1=plan["target1"], target2=plan["target2"],
        risk_pct=plan["risk_pct"], pattern_q=float(q), reasons=reasons, warnings=warnings, wide=plan["wide"],
        levels={"ath": round(ath, 2), "base_low": round(base_low, 2), "ath_date": str(df["timestamp"].iloc[ath_i].date()),
                "issue_price": issue_price},
        metrics={"listing_age_days": listing_age_days, "base_days": base_len, "depth_pct": round(depth, 1),
                 "tight10_pct": round(tight, 1), "since_issue_pct": round(since_issue, 1) if since_issue is not None else None},
        smc={"sweep": bool(smc["sweep"]), "structure_bullish": smc["structure_bullish"]},
    )
