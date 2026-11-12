"""Swing dashboard API: scan, setups (VCP / FLAG / IPO), trades and the accuracy scorecard."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import date
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from backend.models.database import get_db, get_session_factory
from backend.models.tables import SwingSetup, Trade
from backend.services.swing import engine as eng
from backend.services.swing import evaluator as ev
from backend.services.swing import trades as tr
from backend.services.swing.settings import example_trade, get_settings, save_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/swing", tags=["swing"])
_task: Optional[asyncio.Task] = None


def _j(s: Optional[str], default):
    try:
        return json.loads(s) if s else default
    except ValueError:
        return default


def setup_out(r: SwingSetup, *, full: bool = False) -> dict:
    detail = _j(r.detail, {})
    out = {
        "id": r.id, "security_id": r.security_id, "symbol": r.symbol, "name": r.name, "setup": r.setup_type,
        "status": r.status, "active": r.active, "tier": r.tier, "score": r.score, "sector": r.sector,
        "sector_rank": r.sector_rank, "rs_rating": r.rs_rating, "regime": r.regime, "close": r.close,
        "entry": r.entry, "stop": r.stop, "target1": r.target1, "target2": r.target2, "risk_pct": r.risk_pct,
        "top_pick": bool(r.top_pick), "dismissed": bool(r.dismissed), "first_seen": str(r.first_seen),
        "last_seen": str(r.last_seen), "components": _j(r.components, {}), "reasons": _j(r.reasons, []),
        "warnings": _j(r.warnings, []), "distance_pct": round((r.entry / r.close - 1) * 100, 2) if r.close and r.entry else None,
        "rr": round((r.target2 - r.entry) / (r.entry - r.stop), 1) if r.entry and r.stop and r.target2 and r.entry > r.stop else None,
        "levels": detail.get("levels"), "metrics": detail.get("metrics"), "smc": detail.get("smc"),
        "features": detail.get("features"), "event": detail.get("event"), "deals": detail.get("deals"),
        "is_fno": detail.get("is_fno"), "surveillance": detail.get("surveillance"), "timing": detail.get("timing"),
        "broke_out_on": detail.get("broke_out_on"), "breakout_age": detail.get("breakout_age"),
        "carried": bool(detail.get("carried")), "fresh_levels": detail.get("fresh_levels"),
        "sizing": eng.sizing_for(r.entry, r.stop, r.regime) if r.entry and r.stop else None,
        "example": example_trade(r.entry, r.stop, r.target1, r.target2, float(get_settings()["example_capital"]))
        if r.entry and r.stop else None,
        "suggested_on": str(r.suggested_on) if r.suggested_on else None, "eval_status": r.eval_status,
    }
    if full:
        out["chart"] = detail.get("chart")
        out["overhead"] = detail.get("overhead")
    return out


# ── scan ──────────────────────────────────────────────────────────────────

async def _run_scan() -> dict:
    db = get_session_factory()()
    try:
        return await eng.SwingEngine(db).run()
    finally:
        db.close()


@router.post("/scan")
async def start_scan():
    global _task
    if eng.status["running"] or (_task and not _task.done()):
        return {"started": False, "status": eng.status}
    _task = asyncio.create_task(_run_scan())
    await asyncio.sleep(0)
    return {"started": True, "status": eng.status}


@router.get("/scan/status")
def scan_status():
    return {"status": eng.status, "last_run": eng.load_last_run()}


# ── overview / setups ─────────────────────────────────────────────────────

@router.get("/overview")
def overview(db: Session = Depends(get_db)):
    last = eng.load_last_run()
    active = db.query(SwingSetup).filter(SwingSetup.active.is_(True), SwingSetup.dismissed.isnot(True)).all()
    picks = sorted([r for r in active if r.top_pick], key=lambda r: -(r.score or 0))
    counts: dict = {}
    for r in active:
        c = counts.setdefault(r.setup_type, {"total": 0, "triggered": 0, "ready": 0, "forming": 0, "extended": 0})
        c["total"] += 1
        if r.status in c:
            c[r.status] += 1
    open_trades = tr.swing_trades(db)
    return {
        "last_run": last, "scan": eng.status, "regime": last.get("regime"), "settings": get_settings(),
        "top_picks": [setup_out(r, full=True) for r in picks], "counts": counts,
        "open_trades": sum(1 for t in open_trades if t.status == "open"),
        "pending_trades": sum(1 for t in open_trades if t.status == "pending"),
        "unprotected": [t.symbol for t in open_trades if t.status == "open" and t.entry_mode != "paper" and not t.sl_order_id],
    }


@router.get("/setups")
def list_setups(
    setup: Optional[str] = Query(None, description="VCP / FLAG / IPO"),
    status: Optional[str] = Query(None, description="comma list: triggered,ready,forming,extended"),
    min_tier: Optional[str] = Query(None, description="A+ / A / B / C"),
    full: bool = Query(False, description="include the chart (for card view)"),
    db: Session = Depends(get_db),
):
    q = db.query(SwingSetup).filter(SwingSetup.active.is_(True), SwingSetup.dismissed.isnot(True))
    if setup:
        q = q.filter(SwingSetup.setup_type == setup.upper())
    if status:
        q = q.filter(SwingSetup.status.in_([s.strip() for s in status.split(",") if s.strip()]))
    rows = q.all()
    order = {"A+": 0, "A": 1, "B": 2, "C": 3}
    if min_tier in order:
        rows = [r for r in rows if order.get(r.tier or "C", 3) <= order[min_tier]]
    st_order = {"triggered": 0, "ready": 1, "forming": 2, "extended": 3}
    rows.sort(key=lambda r: (not r.top_pick, st_order.get(r.status, 9), -(r.score or 0)))
    return [setup_out(r, full=full) for r in rows]


@router.get("/setups/{setup_id}")
def get_setup(setup_id: int, db: Session = Depends(get_db)):
    r = db.get(SwingSetup, setup_id)
    if not r:
        raise HTTPException(404, "Setup not found")
    return setup_out(r, full=True)


def _card_png(r: SwingSetup) -> bytes:
    from backend.services.swing.card import render_setup_card

    last = eng.load_last_run()
    return render_setup_card(setup_out(r, full=True), regime=last.get("regime"), as_of=last.get("as_of"))


@router.get("/setups/{setup_id}/card.png")
async def setup_card(setup_id: int, db: Session = Depends(get_db)):
    """The Telegram image card (preview / download)."""
    from fastapi.responses import Response

    r = db.get(SwingSetup, setup_id)
    if not r:
        raise HTTPException(404, "Setup not found")
    png = await asyncio.to_thread(_card_png, r)
    return Response(png, media_type="image/png", headers={"Cache-Control": "no-store"})


@router.post("/setups/{setup_id}/notify")
async def notify_setup(setup_id: int, db: Session = Depends(get_db)):
    """Render the setup's image card and send it to the configured Telegram chat."""
    from backend.services.swing.card import build_caption
    from backend.services.telegram_notifier import send_telegram_photo, telegram_is_configured

    r = db.get(SwingSetup, setup_id)
    if not r:
        raise HTTPException(404, "Setup not found")
    if not telegram_is_configured():
        raise HTTPException(400, "Telegram is not configured: add the bot token and chat id in Settings")
    png = await asyncio.to_thread(_card_png, r)
    res = await send_telegram_photo(photo=png, caption=build_caption(setup_out(r, full=True)),
                                    filename=f"{r.symbol}_{r.setup_type}.png")
    if not res.get("ok"):
        raise HTTPException(502, f"Telegram did not accept the card: {res.get('error') or res.get('reason')}")
    return {"ok": True, "message": f"{r.symbol} card sent to Telegram"}


@router.post("/setups/{setup_id}/dismiss")
def dismiss_setup(setup_id: int, undo: bool = False, db: Session = Depends(get_db)):
    r = db.get(SwingSetup, setup_id)
    if not r:
        raise HTTPException(404, "Setup not found")
    r.dismissed = not undo
    if r.dismissed:
        r.top_pick = False
    db.commit()
    return {"ok": True, "dismissed": r.dismissed}


# ── settings ──────────────────────────────────────────────────────────────

@router.get("/settings")
def read_settings():
    return get_settings()


@router.put("/settings")
def write_settings(changes: dict = Body(...)):
    try:
        return save_settings(changes)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/funds")
async def funds():
    from backend.services.dhan_client import DhanClient

    c = DhanClient()
    try:
        f = await c.get_fund_limit()
    finally:
        await c.close()
    if not isinstance(f, dict):
        raise HTTPException(502, "Could not read the fund limit from Dhan")
    avail = f.get("availabelBalance", f.get("availableBalance"))
    return {"available": avail, "utilized": f.get("utilizedAmount"), "withdrawable": f.get("withdrawableBalance"),
            "sod_limit": f.get("sodLimit")}


# ── trades ────────────────────────────────────────────────────────────────

def trade_out(t: Trade, ltp: Optional[float] = None) -> dict:
    entry = float(t.entry_price or 0)
    risk = entry - float(t.initial_sl or t.sl_price or 0)
    px = ltp if ltp else (t.exit_price if t.exit_price else None)
    unreal = (px - entry) * int(t.quantity or 0) if px and t.status == "open" else None
    return {
        "id": t.id, "symbol": t.symbol, "security_id": t.security_id, "setup_id": t.setup_id, "setup": t.setup_type,
        "mode": t.entry_mode, "status": t.status, "qty": t.quantity, "entry": t.entry_price, "sl": t.sl_price,
        "initial_sl": t.initial_sl, "t1": t.t1_price, "t1_done": bool(t.t1_done), "target": t.target_price,
        "entry_date": str(t.entry_date) if t.entry_date else None, "exit_date": str(t.exit_date) if t.exit_date else None,
        "exit_price": t.exit_price, "exit_reason": t.exit_reason, "ltp": ltp,
        "r_now": round((px - entry) / risk, 2) if px and risk > 0 and t.status == "open" else None,
        "r_result": round((float(t.exit_price) - entry) / risk, 2) if t.exit_price and risk > 0 else None,
        "unrealized": round(unreal, 2) if unreal is not None else None, "pnl": t.pnl, "pnl_pct": t.pnl_percentage,
        "protected": bool(t.sl_order_id) if t.entry_mode != "paper" else None, "protection_note": t.protection_note,
        "advice": _j(t.advice, {}), "days_held": t.days_held, "notes": t.notes, "peak": t.peak_price,
        "paper_order": tr.paper_order_type(t) if t.entry_mode == "paper" else None,
    }


@router.get("/trades")
async def list_trades(state: str = Query("open", description="open (open+pending) or closed"),
                      live: bool = True, db: Session = Depends(get_db)):
    if state == "closed":
        rows = (db.query(Trade).filter(Trade.trade_type == "swing", Trade.status.notin_(tr.OPEN_STATES))
                .order_by(Trade.exit_date.desc(), Trade.id.desc()).limit(200).all())
        return [trade_out(t) for t in rows]
    rows = tr.swing_trades(db)
    prices = {}
    if rows and live:
        from backend.services.dhan_client import DhanClient

        c = DhanClient()
        try:
            prices = await tr.live_prices(c, [t.security_id for t in rows])
        finally:
            await c.close()
    return [trade_out(t, prices.get(t.security_id)) for t in rows]


async def _with_client(fn):
    from backend.services.dhan_client import DhanClient

    c = DhanClient()
    try:
        return await fn(c)
    finally:
        await c.close()


def _trade(db: Session, trade_id: int) -> Trade:
    t = db.get(Trade, trade_id)
    if not t or t.trade_type != "swing":
        raise HTTPException(404, "Swing trade not found")
    return t


@router.post("/trades")
async def create_trade(req: dict = Body(...), db: Session = Depends(get_db)):
    return await _with_client(lambda c: tr.open_trade(db, c, req))


@router.put("/trades/{trade_id}")
async def edit_trade(trade_id: int, body: dict = Body(...), db: Session = Depends(get_db)):
    t = _trade(db, trade_id)
    return await _with_client(lambda c: tr.update_trade(db, c, t, body))


@router.post("/trades/{trade_id}/sl")
async def move_sl(trade_id: int, body: dict = Body(...), db: Session = Depends(get_db)):
    t = _trade(db, trade_id)
    try:
        new_sl = float(body.get("new_sl"))
    except (TypeError, ValueError):
        raise HTTPException(400, "new_sl must be a number")
    return await _with_client(lambda c: tr.apply_sl(db, c, t, new_sl, allow_lower=bool(body.get("allow_lower"))))


@router.post("/trades/{trade_id}/partial")
async def partial(trade_id: int, body: dict = Body(...), db: Session = Depends(get_db)):
    t = _trade(db, trade_id)
    return await _with_client(lambda c: tr.book_partial(db, c, t, int(body.get("qty") or 0), body.get("price")))


@router.post("/trades/{trade_id}/exit")
async def exit_trade(trade_id: int, body: dict = Body(default={}), db: Session = Depends(get_db)):
    t = _trade(db, trade_id)
    return await _with_client(lambda c: tr.exit_trade(db, c, t, (body or {}).get("price")))


@router.post("/trades/sync")
async def sync_trades(db: Session = Depends(get_db)):
    """Check fills / protection / exits now (the scheduler also does this during market hours)."""
    events = await _with_client(lambda c: tr.monitor(db, c))
    return {"events": events}


# ── accuracy ──────────────────────────────────────────────────────────────

def _eval_row(r: SwingSetup) -> dict:
    return {"id": r.id, "symbol": r.symbol, "setup": r.setup_type, "tier": r.plan_tier, "regime": r.plan_regime,
            "top_pick": bool(r.plan_top_pick), "suggested_on": str(r.suggested_on), "status": r.eval_status,
            "entry": r.plan_entry, "stop": r.plan_stop, "t1": r.plan_t1, "t2": r.plan_t2, "score": r.plan_score,
            "triggered_on": str(r.triggered_on) if r.triggered_on else None, "fill": r.fill_price,
            "exit_on": str(r.exit_on) if r.exit_on else None, "exit_price": r.exit_price, "r": r.result_r,
            "mfe_r": r.mfe_r, "mae_r": r.mae_r, "days_held": r.days_held, "t1_hit": bool(r.t1_hit)}


@router.get("/accuracy")
def accuracy(days: int = Query(0, description="0 = all time"), db: Session = Depends(get_db)):
    q = db.query(SwingSetup).filter(SwingSetup.suggested_on.isnot(None))
    if days > 0:
        from datetime import timedelta

        q = q.filter(SwingSetup.suggested_on >= date.today() - timedelta(days=days))
    rows = [_eval_row(r) for r in q.order_by(SwingSetup.suggested_on.desc()).all()]

    def group(key):
        out = {}
        for k in sorted({r[key] for r in rows if r[key] is not None}, key=str):
            s = ev.summarize([r for r in rows if r[key] == k])
            out[str(k)] = {**s, "edge": ev.edge_verdict(s)}
        return out

    overall = ev.summarize(rows)
    picks = ev.summarize([r for r in rows if r["top_pick"]])
    closed = sorted([r for r in rows if r["status"] in ev.CLOSED and r["r"] is not None], key=lambda r: r["exit_on"] or "")
    curve, cum = [], 0.0
    for r in closed:
        cum += r["r"]
        curve.append({"date": r["exit_on"], "r": round(cum, 2), "symbol": r["symbol"]})

    real = db.query(Trade).filter(Trade.trade_type == "swing", Trade.status.in_(["closed", "sl_hit", "target_hit"])).all()
    real_rows = []
    for t in real:
        risk = float(t.entry_price or 0) - float(t.initial_sl or 0)
        if risk > 0 and t.exit_price:
            real_rows.append({"status": "win" if t.exit_price > t.entry_price else "loss",
                              "r": round((t.exit_price - t.entry_price) / risk, 2), "days_held": t.days_held or 0,
                              "mode": t.entry_mode})
    return {
        "overall": {**overall, "edge": ev.edge_verdict(overall)}, "top_picks": {**picks, "edge": ev.edge_verdict(picks)},
        "by_setup": group("setup"), "by_tier": group("tier"), "by_regime": group("regime"),
        "curve": curve, "recent": rows[:150],
        "real_trades": {**ev.summarize(real_rows), "pnl": round(sum(float(t.pnl or 0) for t in real), 2),
                        "live": sum(1 for r in real_rows if r["mode"] != "paper"),
                        "paper": sum(1 for r in real_rows if r["mode"] == "paper")},
        "rules": {"max_wait_days": get_settings()["max_wait_days"], "max_hold_days": get_settings()["max_hold_days"]},
    }
