"""Telegram output for swing: the end-of-day digest and intraday breakout alerts."""

from __future__ import annotations

import logging
from datetime import date
from html import escape

from sqlalchemy.orm import Session

from backend.models.tables import SwingSetup

logger = logging.getLogger(__name__)

_alerted: dict[str, set] = {}     # day -> {setup_id} alerted already


def _fmt(x) -> str:
    return f"₹{x:,.2f}" if isinstance(x, (int, float)) else "—"


def build_digest(picks: list[SwingSetup], summary: dict, advice: list[dict]) -> str:
    reg = summary.get("regime") or {}
    label = (reg.get("label") or "?").upper()
    icon = {"UPTREND": "🟢", "CAUTION": "🟡", "DOWNTREND": "🔴"}.get(label, "⚪")
    b = reg.get("breadth") or {}
    lines = [f"<b>Swing setups — {summary.get('as_of')}</b>",
             f"{icon} Market: <b>{label}</b> (score {reg.get('score')}) · {b.get('above50_pct', '?')}% above 50-DMA"]
    if not picks:
        lines.append("\nNo top picks today. " + ("Downtrend: protect capital, cash is a position."
                                                  if label == "DOWNTREND" else "Nothing met the A-grade bar."))
    for i, r in enumerate(picks, 1):
        lines.append(f"\n{i}. <b>{escape(r.symbol)}</b> · {r.setup_type} · {r.tier} {r.score:.0f} · {r.status}"
                     f"\n   Buy above {_fmt(r.entry)} · SL {_fmt(r.stop)} ({r.risk_pct:.1f}%) · T1 {_fmt(r.target1)} · T2 {_fmt(r.target2)}"
                     + (f"\n   {escape(r.sector)} · RS {r.rs_rating}" if r.sector else f"\n   RS {r.rs_rating}"))
    acts = [(a["symbol"], x) for a in advice for x in a.get("actions", []) if x["severity"] in ("high", "medium")]
    if acts:
        lines.append("\n<b>Open trades</b>")
        for sym, x in acts[:10]:
            lines.append(f"• {escape(sym)}: {escape(x['reason'])}")
    s = summary.get("setups") or {}
    lines.append(f"\nScanned {summary.get('scanned')} stocks · VCP {s.get('VCP', 0)} · Flag {s.get('FLAG', 0)} · IPO {s.get('IPO', 0)}")
    return "\n".join(lines)


async def send_swing_digest(db: Session, summary: dict, advice: list[dict]) -> dict:
    from backend.services.telegram_notifier import send_telegram_message, telegram_is_configured

    if not telegram_is_configured():
        return {"ok": False, "reason": "telegram_not_configured"}
    picks = (db.query(SwingSetup).filter(SwingSetup.active.is_(True), SwingSetup.top_pick.is_(True))
             .order_by(SwingSetup.score.desc()).all())
    return await send_telegram_message(build_digest(picks, summary, advice))


async def watch_triggers(db: Session, client) -> list[str]:
    """Alert once per day when a top pick / A-grade ready setup trades through its entry."""
    from backend.services.swing.trades import live_prices
    from backend.services.swing.trades import _alert

    rows = (db.query(SwingSetup).filter(SwingSetup.active.is_(True), SwingSetup.dismissed.isnot(True),
                                        SwingSetup.status.in_(["ready", "triggered"]))
            .filter((SwingSetup.top_pick.is_(True)) | (SwingSetup.tier.in_(["A+", "A"]))).all())
    if not rows:
        return []
    key = date.today().isoformat()
    done = _alerted.setdefault(key, set())
    for k in list(_alerted):
        if k != key:
            _alerted.pop(k)
    prices = await live_prices(client, [r.security_id for r in rows])
    hits = []
    for r in rows:
        ltp = prices.get(r.security_id)
        if not ltp or r.id in done or ltp < r.entry:
            continue
        done.add(r.id)
        chase = (ltp / r.entry - 1) * 100
        note = "extended, do not chase" if chase > 4 else "within buy range"
        hits.append(r.symbol)
        await _alert(f"🚀 <b>{escape(r.symbol)}</b> {r.setup_type} breakout: LTP {_fmt(ltp)} through entry {_fmt(r.entry)} "
                     f"({chase:+.1f}%, {note}). SL {_fmt(r.stop)}. Confirm volume before buying.")
    return hits
