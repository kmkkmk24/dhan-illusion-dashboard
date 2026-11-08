"""
Shared safety helpers for live order flows.

Rules these helpers enforce:
  * Protective GTTs (SL / target) are only placed once the entry order is
    actually filled — never against a pending LIMIT/AMO buy.
  * SL + target on the same position go in ONE OCO forever order, so a fill on
    one leg cancels the other (two SINGLE GTTs can leave a stray SELL live,
    which opens a naked short).
  * Every cancel result is checked; a cancel that fails while the GTT is still
    live is reported, never silently ignored.
  * Concurrent duplicate submits are rejected with 409.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend.models.tables import Trade

logger = logging.getLogger(__name__)

FILLED = "TRADED"
PARTIAL = "PART_TRADED"
DEAD_STATUSES = {"REJECTED", "CANCELLED", "EXPIRED"}
TICK = 0.05

# Prefix used in Trade.notes for manual index trades (plan JSON follows).
MANUAL_INDEX_PREFIX = "manual-index:"


def is_error(res: Any) -> bool:
    return res is None or (isinstance(res, dict) and bool(res.get("error")))


def error_detail(res: Any) -> str:
    if res is None:
        return "no response"
    if isinstance(res, dict):
        return str(res.get("detail") or res.get("error") or res)
    return str(res)


def round_tick(price: float) -> float:
    return round(max(TICK, round(float(price) / TICK) * TICK), 2)


# ── Duplicate-submit guard ────────────────────────────────────────────────

_in_flight: set[str] = set()
_in_flight_lock = asyncio.Lock()


@asynccontextmanager
async def single_flight(key: str):
    """Reject a second concurrent request for the same key with HTTP 409."""
    async with _in_flight_lock:
        if key in _in_flight:
            raise HTTPException(status_code=409, detail="An identical order request is already in progress")
        _in_flight.add(key)
    try:
        yield
    finally:
        async with _in_flight_lock:
            _in_flight.discard(key)


def reject_recent_duplicate(db: Session, security_id: str, *, window_seconds: int = 30) -> None:
    """Reject a re-submit for the same instrument right after a successful one."""
    cutoff = datetime.utcnow() - timedelta(seconds=window_seconds)
    recent = (
        db.query(Trade)
        .filter(
            Trade.security_id == str(security_id),
            Trade.status == "open",
            Trade.created_at >= cutoff,
        )
        .first()
    )
    if recent:
        raise HTTPException(
            status_code=409,
            detail=f"Trade #{recent.id} for this instrument was placed {window_seconds}s ago or less; "
            "refusing a duplicate. Retry after checking your positions.",
        )


# ── Order status ──────────────────────────────────────────────────────────

def parse_order_status(res: Any) -> tuple[Optional[str], int]:
    """Normalise Dhan GET /orders/{id} output (dict or [dict]) to (status, filled_qty)."""
    row = res[0] if isinstance(res, list) and res else res
    if not isinstance(row, dict):
        return None, 0
    status = str(row.get("orderStatus") or "").upper() or None
    try:
        filled = int(float(row.get("filledQty") or 0))
    except (TypeError, ValueError):
        filled = 0
    if status == FILLED and filled <= 0:
        try:
            filled = int(float(row.get("quantity") or 0))
        except (TypeError, ValueError):
            filled = 0
    return status, filled


async def wait_for_fill(client, order_id: str, *, timeout: float = 8.0, interval: float = 1.0) -> tuple[Optional[str], int]:
    """Poll an order until it is filled or dead, or the timeout expires."""
    status, filled = None, 0
    if not order_id:
        return status, filled
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        status, filled = parse_order_status(await client.get_order_by_id(order_id))
        if status == FILLED or status in DEAD_STATUSES:
            return status, filled
        if asyncio.get_event_loop().time() >= deadline:
            return status, filled
        await asyncio.sleep(interval)


# ── GTT helpers ───────────────────────────────────────────────────────────

async def gtt_is_active(client, order_id: str) -> Optional[bool]:
    """True/False if we could determine it from the forever-order book, None if unknown."""
    book = await client.get_forever_orders()
    if not isinstance(book, list):
        return None
    for row in book:
        if str(row.get("orderId")) == str(order_id):
            status = str(row.get("orderStatus") or "").upper()
            return status not in {"CANCELLED", "TRADED", "TRIGGERED", "EXPIRED", "REJECTED"}
    return False


async def cancel_gtt_checked(client, order_id: Optional[str]) -> tuple[bool, str]:
    """Cancel a GTT. Returns (ok, detail). ok=True if it's gone either way."""
    if not order_id:
        return True, "no order"
    res = await client.cancel_forever_order(order_id)
    if not is_error(res):
        return True, "cancelled"
    active = await gtt_is_active(client, order_id)
    if active is False:
        return True, "already inactive"
    return False, f"cancel failed for GTT {order_id}: {error_detail(res)}"


async def place_oco_exit(
    client,
    *,
    security_id: str,
    exchange_segment: str,
    quantity: int,
    target_price: float,
    sl_trigger: float,
    sl_limit_buffer_pct: float = 10.0,
    correlation_id: str = "",
) -> dict:
    """
    One OCO forever order: leg 1 = target (LIMIT SELL), leg 2 = stop loss.
    The SL leg is a LIMIT with a buffer below the trigger so it can fill in a
    fast market.
    """
    sl_limit = round_tick(sl_trigger * (1 - sl_limit_buffer_pct / 100.0))
    return await client.create_forever_order(
        security_id=security_id,
        exchange_segment=exchange_segment,
        transaction_type="SELL",
        product_type="MARGIN",
        order_type="LIMIT",
        order_flag="OCO",
        quantity=quantity,
        price=round_tick(target_price),
        trigger_price=round_tick(target_price),
        price1=sl_limit,
        trigger_price1=round_tick(sl_trigger),
        quantity1=quantity,
        correlation_id=correlation_id,
    )


async def place_sl_gtt(client, *, security_id: str, exchange_segment: str, quantity: int, sl_trigger: float) -> dict:
    return await client.create_forever_order(
        security_id=security_id,
        exchange_segment=exchange_segment,
        transaction_type="SELL",
        product_type="MARGIN",
        order_type="MARKET",
        order_flag="SINGLE",
        quantity=quantity,
        price=0,
        trigger_price=round_tick(sl_trigger),
    )


def trade_segment(trade: Trade) -> str:
    return "BSE_FNO" if "sensex" in str(trade.symbol or "").lower() else "NSE_FNO"


def is_manual_index(trade: Trade) -> bool:
    return str(trade.notes or "").startswith(MANUAL_INDEX_PREFIX)


def manual_executed_qty(trade: Trade) -> int:
    """Quantity already sold by T1/T2 exits, read from the plan JSON in notes."""
    import json

    try:
        payload = str(trade.notes or "").split(MANUAL_INDEX_PREFIX, 1)[1].strip()
        obj, _ = json.JSONDecoder().raw_decode(payload)
        return int(obj.get("executed_qty") or 0) if isinstance(obj, dict) else 0
    except Exception:
        return 0


async def ensure_protection(db: Session, client, trade: Trade, *, remaining_qty: Optional[int] = None) -> dict:
    """
    For an open trade with no protective GTT yet: check the entry fill and,
    once filled, place protection (OCO for SL+target trades, SL-only for manual
    index trades whose targets are handled by the monitor).
    Commits changes to `trade`. Returns {"state": ..., "detail": ...}.
    """
    if trade.status != "open" or trade.sl_order_id:
        return {"state": "protected" if trade.sl_order_id else trade.status}
    if not trade.buy_order_id:
        return {"state": "unknown", "detail": "no buy order id"}

    status, filled = parse_order_status(await client.get_order_by_id(trade.buy_order_id))
    if status in DEAD_STATUSES:
        trade.status = "cancelled"
        db.commit()
        return {"state": "entry_dead", "detail": status}
    if status != FILLED:
        return {"state": "awaiting_fill", "detail": status or "unknown"}

    if remaining_qty is None and is_manual_index(trade):
        remaining_qty = max(0, int(trade.quantity or 0) - manual_executed_qty(trade))
    qty = int(remaining_qty if remaining_qty is not None else (filled or trade.quantity or 0))
    if qty <= 0:
        return {"state": "nothing_to_protect"}
    seg = trade_segment(trade)
    if is_manual_index(trade) or not trade.target_price:
        res = await place_sl_gtt(
            client, security_id=trade.security_id, exchange_segment=seg, quantity=qty,
            sl_trigger=float(trade.sl_price or 0),
        )
    else:
        res = await place_oco_exit(
            client, security_id=trade.security_id, exchange_segment=seg, quantity=qty,
            target_price=float(trade.target_price), sl_trigger=float(trade.sl_price or 0),
        )
    if is_error(res):
        logger.error("UNPROTECTED POSITION trade=%s: %s", trade.id, error_detail(res))
        return {"state": "protection_failed", "detail": error_detail(res)}
    trade.sl_order_id = str(res.get("orderId") or "")
    db.commit()
    return {"state": "protected", "order_id": trade.sl_order_id}


async def ensure_protection_all(db: Session, client) -> list[dict]:
    """Scheduler entry point: protect every open, filled-but-unprotected trade."""
    rows = (
        db.query(Trade)
        .filter(Trade.status == "open", Trade.trade_type == "option")
        .filter((Trade.sl_order_id.is_(None)) | (Trade.sl_order_id == ""))
        .all()
    )
    out = []
    for t in rows:
        try:
            r = await ensure_protection(db, client, t)
        except Exception as e:  # keep going for other trades
            logger.exception("ensure_protection failed for trade %s", t.id)
            r = {"state": "error", "detail": str(e)}
        out.append({"trade_id": t.id, **r})
    return out
