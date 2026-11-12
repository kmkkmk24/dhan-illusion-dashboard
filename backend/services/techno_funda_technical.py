"""
TechnoFunda — technical analysis engine.

Pure functions over a daily OHLCV DataFrame (columns: timestamp, open, high, low, close, volume),
oldest bar first. Nothing here does I/O, so it is unit-testable with synthetic candles.

Output is a structured dict: indicator values, a checklist of pass/fail/neutral observations,
key price levels, and a 0-100 technical score built from five weighted pillars.
"""

from __future__ import annotations

import math
from typing import Any, Optional

import numpy as np
import pandas as pd

# Pillar weights for the technical score (sum = 100).
TECH_WEIGHTS = {"trend": 35, "momentum": 25, "relative_strength": 20, "volume": 10, "risk": 10}


# ───────────────────────── indicator primitives ─────────────────────────

def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    """Wilder's RSI."""
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = gain / loss.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.where(loss != 0, 100.0)


def true_range(df: pd.DataFrame) -> pd.Series:
    prev = df["close"].shift(1)
    return pd.concat([df["high"] - df["low"], (df["high"] - prev).abs(), (df["low"] - prev).abs()], axis=1).max(axis=1)


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    return true_range(df).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    line = ema(close, fast) - ema(close, slow)
    sig = line.ewm(span=signal, adjust=False, min_periods=signal).mean()
    return line, sig, line - sig


def adx(df: pd.DataFrame, n: int = 14):
    up = df["high"].diff()
    down = -df["low"].diff()
    plus_dm = np.where((up > down) & (up > 0), up, 0.0)
    minus_dm = np.where((down > up) & (down > 0), down, 0.0)
    tr = true_range(df).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    plus_di = 100 * pd.Series(plus_dm, index=df.index).ewm(alpha=1 / n, adjust=False, min_periods=n).mean() / tr
    minus_di = 100 * pd.Series(minus_dm, index=df.index).ewm(alpha=1 / n, adjust=False, min_periods=n).mean() / tr
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return dx.ewm(alpha=1 / n, adjust=False, min_periods=n).mean(), plus_di, minus_di


def stochastic(df: pd.DataFrame, n: int = 14, smooth: int = 3):
    lo = df["low"].rolling(n, min_periods=n).min()
    hi = df["high"].rolling(n, min_periods=n).max()
    k = 100 * (df["close"] - lo) / (hi - lo).replace(0, np.nan)
    k = k.rolling(smooth, min_periods=smooth).mean()
    return k, k.rolling(smooth, min_periods=smooth).mean()


def obv(df: pd.DataFrame) -> pd.Series:
    direction = np.sign(df["close"].diff().fillna(0))
    return (direction * df["volume"]).cumsum()


def to_weekly(df: pd.DataFrame) -> pd.DataFrame:
    w = df.set_index("timestamp").resample("W-FRI").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    )
    return w.dropna(subset=["close"]).reset_index()


# ───────────────────────── helpers ─────────────────────────

def _f(v: Any, nd: int = 2) -> Optional[float]:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(x) or math.isinf(x):
        return None
    return round(x, nd)


def _pct(a: Optional[float], b: Optional[float]) -> Optional[float]:
    """% distance of a from b."""
    if a is None or b in (None, 0):
        return None
    return round((a - b) / b * 100, 2)


def _ret(close: pd.Series, bars: int) -> Optional[float]:
    if len(close) <= bars:
        return None
    return _pct(float(close.iloc[-1]), float(close.iloc[-1 - bars]))


def _check(label: str, status: str, detail: str = "") -> dict:
    """status: pass | fail | neutral | na"""
    return {"label": label, "status": status, "detail": detail}


def _clamp(x: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, x))


def _slope_pct(s: pd.Series, bars: int) -> Optional[float]:
    s = s.dropna()
    if len(s) <= bars:
        return None
    return _pct(float(s.iloc[-1]), float(s.iloc[-1 - bars]))


# ───────────────────────── levels ─────────────────────────

def _swing_points(df: pd.DataFrame, k: int = 5) -> tuple[list[float], list[float]]:
    """Fractal swing highs/lows: a bar higher/lower than k bars on each side."""
    highs, lows = [], []
    h, l = df["high"].values, df["low"].values
    for i in range(k, len(df) - k):
        if h[i] == max(h[i - k : i + k + 1]):
            highs.append(float(h[i]))
        if l[i] == min(l[i - k : i + k + 1]):
            lows.append(float(l[i]))
    return highs, lows


def _cluster(levels: list[float], tol: float) -> list[dict]:
    """Merge nearby levels; strength = how many swings touched the zone."""
    out: list[dict] = []
    for lv in sorted(levels):
        if out and abs(lv - out[-1]["price"]) <= tol:
            c = out[-1]
            c["touches"] += 1
            c["price"] = (c["price"] * (c["touches"] - 1) + lv) / c["touches"]
        else:
            out.append({"price": lv, "touches": 1})
    return out


def key_levels(df: pd.DataFrame, atr_val: Optional[float]) -> dict:
    last = float(df["close"].iloc[-1])
    recent = df.tail(260)
    highs, lows = _swing_points(recent)
    tol = (atr_val or last * 0.02) * 0.6
    zones = _cluster(highs + lows, tol)
    supports = sorted([z for z in zones if z["price"] < last * 0.995], key=lambda z: -z["price"])[:3]
    resistances = sorted([z for z in zones if z["price"] > last * 1.005], key=lambda z: z["price"])[:3]

    hi52 = float(recent["high"].max())
    lo52 = float(recent["low"].min())
    # Classic floor pivots from the last completed week.
    w = to_weekly(df)
    piv = {}
    if len(w) >= 2:
        pw = w.iloc[-2]
        p = (pw["high"] + pw["low"] + pw["close"]) / 3
        piv = {
            "pivot": _f(p), "r1": _f(2 * p - pw["low"]), "s1": _f(2 * p - pw["high"]),
            "r2": _f(p + (pw["high"] - pw["low"])), "s2": _f(p - (pw["high"] - pw["low"])),
        }
    rng = hi52 - lo52
    fib = {
        f"{int(r * 1000) / 10:g}%": _f(hi52 - rng * r) for r in (0.236, 0.382, 0.5, 0.618, 0.786)
    } if rng > 0 else {}

    def fmt(zs):
        return [{"price": _f(z["price"]), "touches": z["touches"], "distance_pct": _pct(z["price"], last)} for z in zs]

    return {
        "supports": fmt(supports),
        "resistances": fmt(resistances),
        "high_52w": _f(hi52), "low_52w": _f(lo52),
        "from_52w_high_pct": _pct(last, hi52), "from_52w_low_pct": _pct(last, lo52),
        "weekly_pivots": piv,
        "fibonacci_52w": fib,
    }


# ───────────────────────── main analysis ─────────────────────────

def analyze_technicals(df: pd.DataFrame, bench: Optional[pd.DataFrame] = None) -> dict:
    """Full technical read. `bench` = Nifty 50 daily candles for relative strength."""
    if df is None or len(df) < 30:
        return {"available": False, "reason": "Not enough price history (need at least 30 sessions)."}

    df = df.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df = df.sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)
    for c in ("open", "high", "low", "close", "volume"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["close"]).reset_index(drop=True)

    c = df["close"]
    last = float(c.iloc[-1])
    n = len(df)
    checks: dict[str, list] = {"trend": [], "momentum": [], "relative_strength": [], "volume": [], "risk": []}

    # ── Trend ──
    mas = {f"sma{p}": sma(c, p) for p in (20, 50, 100, 150, 200)}
    mas.update({"ema9": ema(c, 9), "ema21": ema(c, 21)})
    ma_now = {k: _f(v.iloc[-1]) for k, v in mas.items()}
    ma_table = [
        {"name": k.upper().replace("SMA", "SMA ").replace("EMA", "EMA "), "value": v,
         "distance_pct": _pct(last, v), "above": (last > v) if v else None}
        for k, v in ma_now.items()
    ]
    s50, s150, s200 = ma_now["sma50"], ma_now["sma150"], ma_now["sma200"]
    slope200 = _slope_pct(mas["sma200"], 22)
    slope50 = _slope_pct(mas["sma50"], 10)

    t = checks["trend"]
    if s200:
        t.append(_check("Price above 200-DMA", "pass" if last > s200 else "fail", f"{_pct(last, s200)}% from 200-DMA"))
        t.append(_check("200-DMA rising (1 month)", "pass" if (slope200 or 0) > 0 else "fail", f"slope {slope200}%"))
    else:
        t.append(_check("Price above 200-DMA", "na", "Less than 200 sessions of history"))
    if s50:
        t.append(_check("Price above 50-DMA", "pass" if last > s50 else "fail", f"{_pct(last, s50)}% from 50-DMA"))
    if s50 and s200:
        t.append(_check("50-DMA above 200-DMA (golden-cross regime)", "pass" if s50 > s200 else "fail"))
    if ma_now["ema9"] and ma_now["ema21"]:
        t.append(_check("Short-term EMA 9 > EMA 21", "pass" if ma_now["ema9"] > ma_now["ema21"] else "fail"))

    # Last golden/death cross
    cross = None
    if mas["sma200"].notna().sum() > 2:
        diff = (mas["sma50"] - mas["sma200"]).dropna()
        sign = np.sign(diff)
        flips = sign[sign != sign.shift(1)].iloc[1:]
        if len(flips):
            idx = flips.index[-1]
            cross = {"type": "golden" if flips.iloc[-1] > 0 else "death",
                     "date": df.loc[idx, "timestamp"].strftime("%Y-%m-%d"), "sessions_ago": int(n - 1 - idx)}

    # Minervini trend template (needs ~1y)
    hi52 = float(df["high"].tail(252).max())
    lo52 = float(df["low"].tail(252).min())
    template = []
    if s50 and s150 and s200:
        s200_1m = mas["sma200"].dropna()
        template = [
            _check("Price > 150 & 200 DMA", "pass" if last > s150 and last > s200 else "fail"),
            _check("150-DMA > 200-DMA", "pass" if s150 > s200 else "fail"),
            _check("200-DMA trending up ≥1 month", "pass" if len(s200_1m) > 22 and s200_1m.iloc[-1] > s200_1m.iloc[-22] else "fail"),
            _check("50-DMA > 150 & 200 DMA", "pass" if s50 > s150 and s50 > s200 else "fail"),
            _check("Price > 50-DMA", "pass" if last > s50 else "fail"),
            _check("≥30% above 52-week low", "pass" if lo52 and last >= lo52 * 1.30 else "fail", f"{_pct(last, lo52)}% above"),
            _check("Within 25% of 52-week high", "pass" if hi52 and last >= hi52 * 0.75 else "fail", f"{_pct(last, hi52)}% from high"),
        ]
    template_score = sum(1 for x in template if x["status"] == "pass")

    # Weinstein stage from the 30-week MA
    w = to_weekly(df)
    stage = {"stage": None, "label": "Insufficient weekly history"}
    if len(w) >= 34:
        wma30 = sma(w["close"], 30)
        wl, wm = float(w["close"].iloc[-1]), float(wma30.iloc[-1])
        wslope = _slope_pct(wma30, 4) or 0
        if wl > wm and wslope > 0.5:
            stage = {"stage": 2, "label": "Stage 2 — Advancing (price above a rising 30-week MA)"}
        elif wl < wm and wslope < -0.5:
            stage = {"stage": 4, "label": "Stage 4 — Declining (price below a falling 30-week MA)"}
        elif wl >= wm:
            stage = {"stage": 3 if wslope <= 0 else 1, "label": "Stage 3 — Topping (flattening 30-week MA)" if wslope <= 0 else "Stage 1 — Basing, turning up"}
        else:
            stage = {"stage": 1 if wslope >= 0 else 4, "label": "Stage 1 — Basing (price near a flat 30-week MA)" if wslope >= 0 else "Stage 4 — Declining"}
        stage["wma30"] = _f(wm)
        stage["wma30_slope_4w_pct"] = _f(wslope)
    weekly_trend = None
    if len(w) >= 12:
        w10 = sma(w["close"], 10)
        weekly_trend = "up" if float(w["close"].iloc[-1]) > float(w10.iloc[-1]) and (_slope_pct(w10, 3) or 0) > 0 else (
            "down" if float(w["close"].iloc[-1]) < float(w10.iloc[-1]) else "sideways")

    trend_pts = sum({"pass": 1, "fail": 0}.get(x["status"], 0.5) for x in t if x["status"] != "na")
    trend_den = sum(1 for x in t if x["status"] != "na") or 1
    trend_score = trend_pts / trend_den * 70 + (template_score / 7 * 30 if template else 15)
    if stage.get("stage") == 2:
        trend_score = min(100, trend_score + 5)
    elif stage.get("stage") == 4:
        trend_score = max(0, trend_score - 10)

    # ── Momentum ──
    r = rsi(c)
    rsi_now = _f(r.iloc[-1])
    m_line, m_sig, m_hist = macd(c)
    adx_s, pdi, mdi = adx(df)
    k, d = stochastic(df)
    mom = checks["momentum"]
    if rsi_now is not None:
        zone = "overbought" if rsi_now >= 70 else "oversold" if rsi_now <= 30 else "bullish range" if rsi_now >= 50 else "bearish range"
        mom.append(_check("RSI(14) in bullish range 50–70", "pass" if 50 <= rsi_now < 70 else "neutral" if rsi_now >= 70 else "fail",
                          f"RSI {rsi_now} — {zone}"))
    if m_line.notna().any():
        hist_now, hist_prev = float(m_hist.iloc[-1]), float(m_hist.iloc[-2])
        mom.append(_check("MACD above signal line", "pass" if m_line.iloc[-1] > m_sig.iloc[-1] else "fail",
                          f"histogram {'expanding' if abs(hist_now) > abs(hist_prev) else 'contracting'}"))
        mom.append(_check("MACD above zero (bull regime)", "pass" if m_line.iloc[-1] > 0 else "fail"))
    adx_now = _f(adx_s.iloc[-1])
    if adx_now is not None:
        strong = adx_now >= 25
        bull = pdi.iloc[-1] > mdi.iloc[-1]
        mom.append(_check("ADX shows a strong uptrend (ADX ≥ 25, +DI > −DI)",
                          "pass" if strong and bull else "fail" if strong and not bull else "neutral",
                          f"ADX {adx_now} ({'trending' if strong else 'weak/no trend'}), +DI {_f(pdi.iloc[-1])} / −DI {_f(mdi.iloc[-1])}"))
    returns = {lbl: _ret(c, b) for lbl, b in (("1W", 5), ("1M", 21), ("3M", 63), ("6M", 126), ("1Y", 252))}
    if returns["3M"] is not None:
        mom.append(_check("Positive 3-month return", "pass" if returns["3M"] > 0 else "fail", f"{returns['3M']}%"))
    mom_pts = sum({"pass": 1, "fail": 0}.get(x["status"], 0.5) for x in mom)
    momentum_score = mom_pts / (len(mom) or 1) * 100
    if rsi_now and rsi_now >= 80:
        momentum_score -= 10  # stretched

    # ── Relative strength vs Nifty 50 ──
    rs_block: dict[str, Any] = {"available": False}
    rs_score = 50.0
    rsc = checks["relative_strength"]
    if bench is not None and len(bench) > 30:
        b = bench.copy()
        b["timestamp"] = pd.to_datetime(b["timestamp"])
        merged = pd.merge(df[["timestamp", "close"]], b[["timestamp", "close"]].rename(columns={"close": "bclose"}),
                          on="timestamp", how="inner")
        if len(merged) > 30:
            ratio = merged["close"] / merged["bclose"]
            bench_ret = {lbl: _ret(merged["bclose"], bars) for lbl, bars in (("1M", 21), ("3M", 63), ("6M", 126), ("1Y", 252))}
            stock_ret = {lbl: _ret(merged["close"], bars) for lbl, bars in (("1M", 21), ("3M", 63), ("6M", 126), ("1Y", 252))}
            out = {lbl: (round(stock_ret[lbl] - bench_ret[lbl], 2) if stock_ret[lbl] is not None and bench_ret[lbl] is not None else None)
                   for lbl in bench_ret}
            # Mansfield RS: ratio vs its 52-week (or available) mean
            look = min(len(ratio), 252)
            mansfield = _f((ratio.iloc[-1] / ratio.tail(look).mean() - 1) * 100)
            rs_trend = _slope_pct(sma(ratio, 20), 21)
            rs_block = {"available": True, "benchmark": "NIFTY 50", "stock_returns": stock_ret,
                        "benchmark_returns": bench_ret, "outperformance": out,
                        "mansfield_rs": mansfield, "rs_line_trend_1m_pct": rs_trend}
            for lbl in ("3M", "6M", "1Y"):
                if out[lbl] is not None:
                    rsc.append(_check(f"Outperforming Nifty over {lbl}", "pass" if out[lbl] > 0 else "fail", f"{out[lbl]:+} pts"))
            if mansfield is not None:
                rsc.append(_check("Mansfield RS positive", "pass" if mansfield > 0 else "fail", f"{mansfield}"))
            if rs_trend is not None:
                rsc.append(_check("RS line rising (1 month)", "pass" if rs_trend > 0 else "fail"))
            if rsc:
                rs_score = sum(1 for x in rsc if x["status"] == "pass") / len(rsc) * 100
    if not rsc:
        rsc.append(_check("Relative strength vs Nifty", "na", "Benchmark history unavailable"))

    # ── Volume ──
    v = df["volume"].fillna(0)
    vol20 = float(v.tail(20).mean()) if n >= 20 else None
    vol50 = float(v.tail(50).mean()) if n >= 50 else None
    rel_vol = _f(v.iloc[-1] / vol20) if vol20 else None
    tail = df.tail(26).copy()
    tail["chg"] = tail["close"].diff()
    tail["vchg"] = tail["volume"].diff()
    tail = tail.iloc[1:]
    acc_days = int(((tail["chg"] > 0) & (tail["vchg"] > 0)).sum())
    dist_days = int(((tail["chg"] < 0) & (tail["vchg"] > 0)).sum())
    obv_s = obv(df)
    obv_trend = _slope_pct(obv_s.abs() + 1, 20)  # guard sign flips
    obv_up = float(obv_s.iloc[-1]) > float(obv_s.iloc[-21]) if n > 21 else None
    up_vol = float(df.tail(50).loc[df.tail(50)["close"].diff() > 0, "volume"].sum())
    dn_vol = float(df.tail(50).loc[df.tail(50)["close"].diff() < 0, "volume"].sum())
    ud_ratio = _f(up_vol / dn_vol) if dn_vol else None
    vc = checks["volume"]
    if obv_up is not None:
        vc.append(_check("OBV rising over 20 sessions", "pass" if obv_up else "fail"))
    vc.append(_check("More accumulation than distribution days (25 sessions)",
                     "pass" if acc_days > dist_days else "fail" if dist_days > acc_days else "neutral",
                     f"{acc_days} accumulation vs {dist_days} distribution"))
    if ud_ratio is not None:
        vc.append(_check("Up/Down volume ratio > 1 (50 sessions)", "pass" if ud_ratio > 1 else "fail", f"{ud_ratio}"))
    if vol20 and vol50:
        vc.append(_check("20-day volume above 50-day average", "pass" if vol20 > vol50 else "neutral", f"{_f(vol20 / vol50)}x"))
    volume_score = sum({"pass": 1, "fail": 0}.get(x["status"], 0.5) for x in vc) / (len(vc) or 1) * 100

    # ── Volatility & risk ──
    atr_s = atr(df)
    atr_now = _f(atr_s.iloc[-1])
    atr_pct = _f(atr_now / last * 100) if atr_now else None
    bb_mid = sma(c, 20)
    bb_sd = c.rolling(20, min_periods=20).std()
    bb_up, bb_lo = bb_mid + 2 * bb_sd, bb_mid - 2 * bb_sd
    bb_width = (bb_up - bb_lo) / bb_mid * 100
    pct_b = _f((last - bb_lo.iloc[-1]) / (bb_up.iloc[-1] - bb_lo.iloc[-1])) if bb_sd.iloc[-1] else None
    bw_now = _f(bb_width.iloc[-1])
    squeeze = bool(bw_now is not None and bb_width.tail(126).dropna().size > 20 and bw_now <= float(bb_width.tail(126).quantile(0.2)))
    hv20 = _f(c.pct_change().tail(20).std() * math.sqrt(252) * 100)
    roll_max = c.cummax()
    dd = (c / roll_max - 1) * 100
    max_dd_1y = _f(dd.tail(252).min())
    rk = checks["risk"]
    if atr_pct is not None:
        rk.append(_check("Daily volatility manageable (ATR < 4% of price)", "pass" if atr_pct < 4 else "fail", f"ATR {atr_now} = {atr_pct}%"))
    if s50:
        ext = _pct(last, s50)
        rk.append(_check("Not over-extended (< 15% above 50-DMA)", "pass" if (ext or 0) < 15 else "fail", f"{ext}% above 50-DMA"))
    if pct_b is not None:
        rk.append(_check("Inside Bollinger Bands", "pass" if 0 <= pct_b <= 1 else "neutral",
                         f"%B {pct_b}{' — volatility squeeze (low band width)' if squeeze else ''}"))
    if max_dd_1y is not None:
        rk.append(_check("1-year max drawdown shallower than −35%", "pass" if max_dd_1y > -35 else "fail", f"{max_dd_1y}%"))
    risk_score = sum({"pass": 1, "fail": 0}.get(x["status"], 0.5) for x in rk) / (len(rk) or 1) * 100

    levels = key_levels(df, atr_now)

    # ── Score ──
    pillars = {
        "trend": round(_clamp(trend_score)),
        "momentum": round(_clamp(momentum_score)),
        "relative_strength": round(_clamp(rs_score)),
        "volume": round(_clamp(volume_score)),
        "risk": round(_clamp(risk_score)),
    }
    score = round(sum(pillars[k] * w for k, w in TECH_WEIGHTS.items()) / sum(TECH_WEIGHTS.values()))

    # ── Setup / levels plan (not a recommendation) ──
    plan = _trade_levels(last, atr_now, levels, s50)

    # Short headline for the summary
    if score >= 70:
        bias = "Bullish"
    elif score >= 55:
        bias = "Mildly bullish"
    elif score >= 45:
        bias = "Neutral"
    elif score >= 30:
        bias = "Mildly bearish"
    else:
        bias = "Bearish"

    chart = df.tail(260)
    return {
        "available": True,
        "as_of": df["timestamp"].iloc[-1].strftime("%Y-%m-%d"),
        "sessions": n,
        "last_close": _f(last),
        "score": score,
        "bias": bias,
        "pillars": pillars,
        "weights": TECH_WEIGHTS,
        "checks": checks,
        "trend": {
            "moving_averages": ma_table,
            "sma200_slope_1m_pct": slope200,
            "sma50_slope_2w_pct": slope50,
            "last_cross": cross,
            "trend_template": {"passed": template_score, "total": len(template), "checks": template},
            "stage": stage,
            "weekly_trend": weekly_trend,
        },
        "momentum": {
            "rsi14": rsi_now,
            "macd": _f(m_line.iloc[-1], 3), "macd_signal": _f(m_sig.iloc[-1], 3), "macd_hist": _f(m_hist.iloc[-1], 3),
            "adx14": adx_now, "plus_di": _f(pdi.iloc[-1]), "minus_di": _f(mdi.iloc[-1]),
            "stoch_k": _f(k.iloc[-1]), "stoch_d": _f(d.iloc[-1]),
            "returns": returns,
        },
        "relative_strength": rs_block,
        "volume": {
            "last": _f(v.iloc[-1], 0), "avg20": _f(vol20, 0), "avg50": _f(vol50, 0), "relative_volume": rel_vol,
            "accumulation_days": acc_days, "distribution_days": dist_days, "up_down_ratio_50d": ud_ratio,
            "obv_rising_20d": obv_up,
        },
        "volatility": {
            "atr14": atr_now, "atr_pct": atr_pct, "hv20_annualised_pct": hv20,
            "bb_upper": _f(bb_up.iloc[-1]), "bb_lower": _f(bb_lo.iloc[-1]), "bb_pct_b": pct_b,
            "bb_width_pct": bw_now, "squeeze": squeeze, "max_drawdown_1y_pct": max_dd_1y,
        },
        "levels": levels,
        "plan": plan,
        "chart": {
            "dates": [d_.strftime("%Y-%m-%d") for d_ in chart["timestamp"]],
            "close": [_f(x) for x in chart["close"]],
            "volume": [_f(x, 0) for x in chart["volume"]],
            "sma50": [_f(x) for x in mas["sma50"].tail(260)],
            "sma200": [_f(x) for x in mas["sma200"].tail(260)],
        },
    }


def _trade_levels(last: float, atr_val: Optional[float], levels: dict, s50: Optional[float]) -> dict:
    """ATR/structure-based reference levels. Educational, not a trade call."""
    if not atr_val:
        return {"available": False}
    sup = [s["price"] for s in levels.get("supports") or [] if s.get("price")]
    res = [r["price"] for r in levels.get("resistances") or [] if r.get("price")]
    structural = sup[0] if sup else None
    atr_stop = last - 2 * atr_val
    # Use the tighter of (just below nearest support) and 2×ATR, but never tighter than 1×ATR.
    stop = atr_stop
    if structural and structural < last:
        stop = max(atr_stop, structural - 0.5 * atr_val)
    stop = min(stop, last - atr_val)
    risk = last - stop
    t1 = res[0] if res and res[0] > last + 0.5 * risk else last + 2 * risk
    t2 = res[1] if len(res) > 1 and res[1] > t1 else last + 3 * risk
    entry_lo = max(stop + 0.5 * risk, (s50 if s50 and s50 < last else last - 0.5 * atr_val))
    return {
        "available": True,
        "reference_price": _f(last),
        "entry_zone": [_f(min(entry_lo, last)), _f(last)],
        "stop_loss": _f(stop),
        "stop_basis": "below nearest support" if structural and stop > atr_stop else "2 × ATR",
        "risk_per_share": _f(risk),
        "risk_pct": _f(risk / last * 100),
        "target_1": _f(t1), "target_1_rr": _f((t1 - last) / risk) if risk else None,
        "target_2": _f(t2), "target_2_rr": _f((t2 - last) / risk) if risk else None,
    }
