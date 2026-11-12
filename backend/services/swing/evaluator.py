"""
Automated accuracy check of swing suggestions.

Every setup the dashboard suggested (status ready/triggered with a frozen plan) is
replayed on the daily candles that followed, with deliberately honest rules:

  * Trigger: within `max_wait` sessions the high reaches the entry. A gap-up open
    above the entry fills at the open (slippage), not at the entry.
  * Before the trigger, a low below the stop cancels the idea ("invalidated", no loss).
  * After the trigger: a low at/below the stop exits at min(open, stop) (gap-downs
    hurt). If the stop and a target are both touched on the same day, the stop is
    assumed to have hit first.
  * Management model (the same one the trade advice uses): book half at T1 (2R) and
    move the stop to breakeven; the rest exits at T2, the stop, or the close after
    `max_hold` sessions.

Result is in R (multiples of the initial risk), plus MFE/MAE, so setups with
different stop distances are comparable.
"""

from __future__ import annotations

from typing import Optional

import pandas as pd


def evaluate_plan(plan: dict, after: pd.DataFrame, *, max_wait: int = 10, max_hold: int = 30) -> dict:
    """
    plan: {entry, stop, target1, target2}; after: candles strictly after the suggestion day.
    Returns {status, triggered_on, fill, exit_on, exit_price, r, mfe_r, mae_r, days_held, t1_hit}.
    status: pending | no_trigger | invalidated | open | win | loss | breakeven | timeout
    """
    entry, stop = float(plan["entry"]), float(plan["stop"])
    t1, t2 = float(plan["target1"]), float(plan["target2"])
    risk = entry - stop
    out = {"status": "pending", "triggered_on": None, "fill": None, "exit_on": None, "exit_price": None,
           "r": None, "mfe_r": None, "mae_r": None, "days_held": None, "t1_hit": False}
    if risk <= 0 or after is None or after.empty:
        return out
    rows = after.sort_values("timestamp").reset_index(drop=True)

    trig_i = None
    for i in range(min(max_wait, len(rows))):
        r = rows.iloc[i]
        if r["low"] <= stop and r["high"] < entry:
            out.update(status="invalidated", exit_on=_d(r))
            return out
        if r["high"] >= entry:
            trig_i = i
            break
    if trig_i is None:
        if len(rows) >= max_wait:
            out["status"] = "no_trigger"
        return out

    tr = rows.iloc[trig_i]
    fill = max(float(tr["open"]), entry)
    out.update(triggered_on=_d(tr), fill=round(fill, 2))
    risk_r = fill - stop if fill > stop else risk
    cur_stop, half_booked, booked_r = stop, False, 0.0
    mfe, mae = 0.0, 0.0

    for j in range(trig_i, len(rows)):
        r = rows.iloc[j]
        o, h, l, c = float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])
        held = j - trig_i
        mfe = max(mfe, (h - fill) / risk_r)
        mae = min(mae, (l - fill) / risk_r)
        # same-bar entry: only the stop can hit on the trigger day if the low came after the entry
        if l <= cur_stop:
            px = min(o, cur_stop) if j > trig_i else cur_stop
            rest = (px - fill) / risk_r
            total = 0.5 * booked_r + 0.5 * rest if half_booked else rest
            status = "loss" if total < -0.05 else ("breakeven" if total <= 0.05 else "win")
            return _close(out, r, px, total, mfe, mae, held, status)
        if not half_booked and h >= t1:
            half_booked, booked_r = True, (t1 - fill) / risk_r
            out["t1_hit"] = True
            cur_stop = max(cur_stop, fill)
        if h >= t2:
            px = max(o, t2) if j > trig_i else t2
            rest = (px - fill) / risk_r
            total = 0.5 * booked_r + 0.5 * rest if half_booked else rest
            return _close(out, r, px, total, mfe, mae, held, "win")
        if held >= max_hold:
            rest = (c - fill) / risk_r
            total = 0.5 * booked_r + 0.5 * rest if half_booked else rest
            return _close(out, r, c, total, mfe, mae, held, "timeout")

    last = rows.iloc[-1]
    open_r = (float(last["close"]) - fill) / risk_r
    out.update(status="open", r=round(0.5 * booked_r + 0.5 * open_r if half_booked else open_r, 2),
               mfe_r=round(mfe, 2), mae_r=round(mae, 2), days_held=len(rows) - 1 - trig_i)
    return out


def _d(row) -> str:
    return pd.Timestamp(row["timestamp"]).date().isoformat()


def _close(out: dict, row, px: float, r: float, mfe: float, mae: float, held: int, status: str) -> dict:
    out.update(status=status, exit_on=_d(row), exit_price=round(px, 2), r=round(r, 2),
               mfe_r=round(mfe, 2), mae_r=round(mae, 2), days_held=held)
    return out


CLOSED = {"win", "loss", "breakeven", "timeout"}


def summarize(rows: list[dict]) -> dict:
    """rows: [{status, r, days_held}] -> trigger rate, win rate, avg R, expectancy, profit factor."""
    decided = [r for r in rows if r["status"] in CLOSED | {"no_trigger", "invalidated"}]
    closed = [r for r in rows if r["status"] in CLOSED and r.get("r") is not None]
    triggered = [r for r in rows if r["status"] in CLOSED | {"open"}]
    wins = [r for r in closed if r["r"] > 0.05]
    losses = [r for r in closed if r["r"] < -0.05]
    gross_win = sum(r["r"] for r in wins)
    gross_loss = -sum(r["r"] for r in losses)
    n = len(closed)
    return {
        "suggested": len(rows),
        "triggered": len(triggered),
        "trigger_rate": round(len(triggered) / len(decided) * 100, 1) if decided else None,
        "closed": n,
        "open": sum(1 for r in rows if r["status"] == "open"),
        "win_rate": round(len(wins) / n * 100, 1) if n else None,
        "avg_r": round(sum(r["r"] for r in closed) / n, 2) if n else None,
        "avg_win_r": round(gross_win / len(wins), 2) if wins else None,
        "avg_loss_r": round(-gross_loss / len(losses), 2) if losses else None,
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else (None if not wins else 99.0),
        "avg_days": round(sum(r.get("days_held") or 0 for r in closed) / n, 1) if n else None,
        "total_r": round(sum(r["r"] for r in closed), 2),
        "invalidated": sum(1 for r in rows if r["status"] == "invalidated"),
        "no_trigger": sum(1 for r in rows if r["status"] == "no_trigger"),
    }


def edge_verdict(s: dict, min_samples: int = 15) -> Optional[str]:
    if (s.get("closed") or 0) < min_samples:
        return None
    if (s.get("avg_r") or 0) <= 0:
        return "negative"
    return "positive" if (s.get("avg_r") or 0) >= 0.25 else "thin"
