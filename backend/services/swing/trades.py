"""
Swing trade execution and management (NSE cash, CNC delivery).

Entry modes
  paper  tracked only, no broker order (the default way to start)
  gtt    Dhan Forever Order BUY with trigger = entry (a buy-stop that waits for the
         breakout), limit = entry + 0.5%. A gap far above the entry does not fill,
         so a breakout is never chased.
  limit  regular CNC LIMIT BUY now (AMO when the market is closed)

Protection: once the entry fills, ONE OCO Forever Order is placed (target leg + stop-loss
leg, CNC), so a fill on one leg cancels the other. It is retried every cycle until it
succeeds, and the dashboard shows the trade as UNPROTECTED until then.

Selling CNC holdings needs CDSL eDIS authorisation (or DDPI). The eDIS status is checked
after protection; when shares are not authorised the trade is flagged, because the SL
leg would be rejected exactly when it is needed.

Management advice (end of day, from daily candles), all rules only ever RAISE the stop:
  failed breakout     close back below the pivot within 3 sessions -> exit (small loss)
  +1.5R               stop to breakeven
  T1 (2R)             book half, stop to breakeven
  > +2R               trail under the 21-EMA (10-EMA for flags) minus 0.5 ATR
  close < 50-DMA on   volume >= 1.5x -> exit
  10 sessions < +0.5R time stop: momentum did not come
  results within 2d   tighten / book partial
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime
from typing import Any, Optional

import pandas as pd
from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend.models.tables import Instrument, SwingSetup, Trade
from backend.services import order_safety as osf
from backend.services.swing.settings import get_settings
from backend.services.techno_funda_technical import atr, ema, sma

logger = logging.getLogger(__name__)

SEG = "NSE_EQ"
PRODUCT = "CNC"
ENTRY_LIMIT_BUFFER = 0.005
SL_LIMIT_BUFFER = 0.015
OPEN_STATES = ("pending", "open")


def _tick(x: float) -> float:
    return osf.round_tick(x)


def swing_trades(db: Session, states=OPEN_STATES) -> list[Trade]:
    return db.query(Trade).filter(Trade.trade_type == "swing", Trade.status.in_(states)).all()


def _advice(trade: Trade) -> dict:
    try:
        return json.loads(trade.advice or "{}")
    except ValueError:
        return {}


def _set_advice(trade: Trade, **kw) -> None:
    a = _advice(trade)
    a.update(kw)
    trade.advice = json.dumps(a, default=str)


def _ltp_map(raw: Any) -> dict[str, float]:
    out = {}
    data = (raw or {}).get("data") if isinstance(raw, dict) else None
    for seg in (data or {}).values():
        if isinstance(seg, dict):
            for sid, info in seg.items():
                try:
                    out[str(sid)] = float(info.get("last_price") or 0)
                except (TypeError, ValueError, AttributeError):
                    continue
    return out


async def live_prices(client, security_ids: list[str]) -> dict[str, float]:
    ids = sorted({str(s) for s in security_ids if s})
    if not ids:
        return {}
    try:
        return _ltp_map(await client.get_market_quote_ltp(ids, SEG))
    except Exception as e:
        logger.warning("Swing LTP fetch failed: %s", e)
        return {}


# ── open ──────────────────────────────────────────────────────────────────

async def open_trade(db: Session, client, req: dict) -> dict:
    s = get_settings()
    mode = str(req.get("mode") or "paper").lower()
    if mode not in ("paper", "gtt", "limit"):
        raise HTTPException(400, "mode must be paper, gtt or limit")
    sid = str(req.get("security_id") or "")
    setup = db.get(SwingSetup, int(req["setup_id"])) if req.get("setup_id") else None
    if setup:
        sid = setup.security_id
    inst = db.query(Instrument).filter(Instrument.security_id == sid).first()
    if not sid or not inst:
        raise HTTPException(404, "Unknown security")
    symbol = req.get("symbol") or (setup.symbol if setup else (inst.trading_symbol or inst.symbol))
    try:
        qty = int(req.get("qty") or 0)
        entry, stop = float(req.get("entry") or 0), float(req.get("stop") or 0)
        target = float(req.get("target") or 0)
        t1 = float(req.get("t1") or 0) or round(entry + 2 * (entry - stop), 2)
    except (TypeError, ValueError):
        raise HTTPException(400, "qty, entry, stop and target must be numbers")
    if qty < 1:
        raise HTTPException(400, "Quantity must be at least 1")
    if not (0 < stop < entry < target):
        raise HTTPException(400, "Require 0 < stop < entry < target")
    if (entry - stop) / entry > 0.15:
        raise HTTPException(400, "Stop is more than 15% below the entry: refusing (swing risk control)")
    risk_amt = qty * (entry - stop)
    max_risk = float(s["capital"]) * 0.03
    if risk_amt > max_risk and not req.get("override_risk"):
        raise HTTPException(400, f"Risk ₹{risk_amt:,.0f} exceeds 3% of capital (₹{max_risk:,.0f}); "
                                 "reduce quantity or confirm the override")
    open_rows = swing_trades(db)
    if any(t.security_id == sid for t in open_rows):
        raise HTTPException(409, f"{symbol} already has an open or pending swing trade")
    if len(open_rows) >= int(s["max_open_trades"]) and not req.get("override_limits"):
        raise HTTPException(409, f"Already {len(open_rows)} open swing trades (max {s['max_open_trades']}); "
                                 "confirm the override to exceed it")
    regime = (setup.regime if setup else None)
    if regime == "downtrend" and mode != "paper" and not req.get("override_regime"):
        raise HTTPException(409, "Market regime is DOWNTREND: new live entries are blocked. "
                                 "Paper-trade it, or confirm the override.")

    trade = Trade(
        security_id=sid, symbol=symbol, trade_type="swing", setup_id=setup.id if setup else None,
        setup_type=(setup.setup_type if setup else str(req.get("setup_type") or "MANUAL"))[:10],
        entry_mode=mode, entry_price=entry, sl_price=stop, initial_sl=stop, target_price=target, t1_price=t1,
        quantity=qty, status="pending", t1_done=False, sl_order_id="", target_order_id="", buy_order_id="",
        risk_reward_ratio=round((target - entry) / (entry - stop), 2),
        notes=str(req.get("notes") or "")[:500],
    )
    result: dict[str, Any] = {"mode": mode}

    if mode == "paper":
        fill = float(req.get("fill_price") or 0)
        if fill > 0 or req.get("already_filled"):
            trade.status, trade.entry_price, trade.entry_date = "open", fill or entry, date.today()
            trade.peak_price = trade.entry_price
        db.add(trade)
        db.commit()
        db.refresh(trade)
        return {**result, "trade_id": trade.id, "status": trade.status,
                "message": "Paper trade recorded" + (" (open)" if trade.status == "open" else ": waits for the entry price")}

    from backend.services.market_calendar import is_market_open

    async with osf.single_flight(f"swing:{sid}"):
        try:
            held = [h for h in (await client.get_holdings() or []) if isinstance(h, dict)
                    and str(h.get("securityId")) == sid and float(h.get("totalQty") or 0) > 0]
        except Exception:
            held = []
        if held and not req.get("override_holding"):
            raise HTTPException(409, f"You already hold {int(float(held[0].get('totalQty') or 0))} {symbol} in Dhan "
                                     "(outside this trade). Confirm the override to add more exposure.")
        ltp = (await live_prices(client, [sid])).get(sid)
        if mode == "gtt":
            if ltp and ltp >= entry:
                raise HTTPException(409, f"Price ₹{ltp:,.2f} is already above the entry ₹{entry:,.2f}: a buy-stop GTT "
                                         "would fire at once. Use 'Buy now (limit)' if it is not extended.")
            res = await client.create_forever_order(
                security_id=sid, exchange_segment=SEG, transaction_type="BUY", product_type=PRODUCT,
                order_type="LIMIT", order_flag="SINGLE", quantity=qty,
                price=_tick(entry * (1 + ENTRY_LIMIT_BUFFER)), trigger_price=_tick(entry),
                correlation_id=f"sw-{symbol[:10]}-buy",
            )
        else:
            limit = float(req.get("limit_price") or 0) or (ltp or entry)
            if limit > entry * 1.04:
                raise HTTPException(409, f"Limit ₹{limit:,.2f} is more than 4% above the entry: extended, do not chase")
            res = await client.place_order(
                security_id=sid, exchange_segment=SEG, transaction_type="BUY", product_type=PRODUCT,
                order_type="LIMIT", quantity=qty, price=_tick(limit), validity="DAY",
                correlation_id=f"sw-{symbol[:10]}-buy", after_market_order=not is_market_open(),
            )
            trade.entry_price = _tick(limit)
        if osf.is_error(res):
            raise HTTPException(400, f"Dhan rejected the entry: {osf.error_detail(res)}")
        trade.buy_order_id = str(res.get("orderId") or "")
        db.add(trade)
        db.commit()
        db.refresh(trade)
        result.update(trade_id=trade.id, status=trade.status, order_id=trade.buy_order_id,
                      message="Buy-stop GTT placed on Dhan; the stop-loss + target OCO is added automatically after it fills"
                      if mode == "gtt" else "Buy order placed; protection is added automatically after it fills")
        return result


# ── protection / fills ────────────────────────────────────────────────────

async def place_protection(db: Session, client, trade: Trade) -> dict:
    qty = int(trade.quantity or 0)
    if qty <= 0:
        return {"state": "nothing_to_protect"}
    res = await client.create_forever_order(
        security_id=trade.security_id, exchange_segment=SEG, transaction_type="SELL", product_type=PRODUCT,
        order_type="LIMIT", order_flag="OCO", quantity=qty,
        price=_tick(trade.target_price), trigger_price=_tick(trade.target_price),
        price1=_tick(trade.sl_price * (1 - SL_LIMIT_BUFFER)), trigger_price1=_tick(trade.sl_price), quantity1=qty,
        correlation_id=f"sw-{trade.id}-oco",
    )
    if osf.is_error(res):
        note = f"UNPROTECTED: OCO failed ({osf.error_detail(res)[:120]})"
        changed = note != trade.protection_note
        trade.protection_note = note
        db.commit()
        if changed:
            await _alert(f"⚠️ <b>{trade.symbol}</b> swing trade is UNPROTECTED: stop-loss GTT failed. "
                         "Place a stop on Dhan now; the app keeps retrying.")
        return {"state": "protection_failed", "detail": osf.error_detail(res)}
    trade.sl_order_id = str(res.get("orderId") or "")
    trade.protection_note = "OCO stop + target live"
    db.commit()
    await check_edis(db, client, trade)
    return {"state": "protected", "order_id": trade.sl_order_id}


async def check_edis(db: Session, client, trade: Trade) -> None:
    inst = db.query(Instrument).filter(Instrument.security_id == trade.security_id).first()
    if not inst or not inst.isin:
        return
    try:
        res = await client.edis_inquire(inst.isin)
    except Exception:
        return
    row = res[0] if isinstance(res, list) and res else res
    if not isinstance(row, dict):
        return
    try:
        approved = int(float(row.get("aprvdQty") or 0))
        total = int(float(row.get("totalQty") or 0))
    except (TypeError, ValueError):
        return
    if total and approved < min(total, int(trade.quantity or 0)):
        trade.protection_note = ("OCO live, but only {}/{} shares are eDIS-authorised: authorise holdings on Dhan "
                                 "(or enable DDPI) or the stop-loss sell will be rejected").format(approved, total)
        db.commit()


def _order_rows(book: Any) -> list[dict]:
    return [r for r in (book or []) if isinstance(r, dict)] if isinstance(book, list) else []


def _avg_fill(book: list[dict], sid: str, side: str, since: Optional[datetime]) -> Optional[tuple[float, int]]:
    rows = [r for r in book if str(r.get("securityId")) == str(sid) and str(r.get("transactionType")).upper() == side
            and str(r.get("orderStatus")).upper() in (osf.FILLED, osf.PARTIAL)]
    if not rows:
        return None
    r = rows[-1]
    try:
        px = float(r.get("averageTradedPrice") or r.get("price") or 0)
        q = int(float(r.get("filledQty") or r.get("quantity") or 0))
    except (TypeError, ValueError):
        return None
    return (px, q) if px > 0 else None


def _close(trade: Trade, price: float, status: str, reason: str) -> None:
    realized = float(trade.pnl or 0) if trade.t1_done else 0.0
    trade.exit_price = round(price, 2)
    trade.exit_date = date.today()
    trade.status = status
    trade.exit_reason = reason[:60]
    trade.pnl = round(realized + (price - float(trade.entry_price or 0)) * int(trade.quantity or 0), 2)
    base = float(trade.entry_price or 0)
    trade.pnl_percentage = round((price / base - 1) * 100, 2) if base else None
    if trade.entry_date:
        trade.days_held = (date.today() - trade.entry_date).days


async def monitor(db: Session, client) -> list[dict]:
    """Fill detection, protection retries and exit detection for live + paper swing trades (market hours)."""
    rows = swing_trades(db)
    if not rows:
        return []
    events: list[dict] = []
    prices = await live_prices(client, [t.security_id for t in rows])
    live = [t for t in rows if t.entry_mode in ("gtt", "limit")]
    book, gtts = [], []
    if live:
        book = _order_rows(await client.get_order_book())
        gtts = _order_rows(await client.get_forever_orders())
    gtt_status = {str(g.get("orderId")): str(g.get("orderStatus") or "").upper() for g in gtts}

    for t in rows:
        ltp = prices.get(t.security_id)
        try:
            if t.entry_mode == "paper":
                ev = _monitor_paper(t, ltp)
            else:
                ev = await _monitor_live(db, client, t, ltp, book, gtt_status)
            if ltp:
                t.peak_price = max(float(t.peak_price or 0), ltp) if t.status == "open" else t.peak_price
            if ev:
                events.append({"trade_id": t.id, "symbol": t.symbol, **ev})
        except Exception as e:
            logger.exception("swing monitor failed for trade %s", t.id)
            events.append({"trade_id": t.id, "symbol": t.symbol, "event": "error", "detail": str(e)[:200]})
    db.commit()
    for ev in events:
        if ev.get("event") in ("filled", "sl_hit", "target_hit", "entry_cancelled"):
            await _alert(f"Swing <b>{ev['symbol']}</b>: {ev['event'].replace('_', ' ')}"
                         + (f" @ ₹{ev['price']:,.2f}" if ev.get("price") else ""))
    return events


def _monitor_paper(t: Trade, ltp: Optional[float]) -> Optional[dict]:
    if not ltp:
        return None
    if t.status == "pending":
        if ltp >= float(t.entry_price):
            t.status, t.entry_date, t.peak_price = "open", date.today(), ltp
            t.entry_price = round(max(ltp, float(t.entry_price)), 2) if ltp > t.entry_price * 1.01 else t.entry_price
            return {"event": "filled", "price": t.entry_price}
        return None
    if ltp <= float(t.sl_price):
        _close(t, ltp, "sl_hit", "Stop loss hit")
        return {"event": "sl_hit", "price": ltp}
    if ltp >= float(t.target_price):
        _close(t, ltp, "target_hit", "Target hit")
        return {"event": "target_hit", "price": ltp}
    return None


async def _monitor_live(db: Session, client, t: Trade, ltp: Optional[float], book: list[dict],
                        gtt_status: dict[str, str]) -> Optional[dict]:
    if t.status == "pending":
        if t.entry_mode == "gtt":
            st = gtt_status.get(t.buy_order_id)
            if st in ("CANCELLED", "EXPIRED", "REJECTED"):
                t.status, t.exit_reason = "cancelled", f"Entry GTT {st.lower()}"
                return {"event": "entry_cancelled"}
            if st not in ("TRADED", "TRIGGERED", "CONFIRM") and st is not None:
                return None
        else:
            st, _ = osf.parse_order_status(await client.get_order_by_id(t.buy_order_id))
            if st in osf.DEAD_STATUSES:
                t.status, t.exit_reason = "cancelled", f"Entry order {st.lower()}"
                return {"event": "entry_cancelled"}
            if st != osf.FILLED:
                return None
        fill = _avg_fill(book, t.security_id, "BUY", None)
        if fill is None:
            return None
        t.entry_price, t.quantity = round(fill[0], 2), fill[1] or t.quantity
        t.status, t.entry_date, t.peak_price = "open", date.today(), fill[0]
        db.commit()
        prot = await place_protection(db, client, t)
        return {"event": "filled", "price": t.entry_price, "protection": prot["state"]}

    # open
    if not t.sl_order_id:
        prot = await place_protection(db, client, t)
        return {"event": "protection", "state": prot["state"]} if prot["state"] != "protected" else None
    st = gtt_status.get(t.sl_order_id)
    if st in ("TRADED", "TRIGGERED"):
        sold = _avg_fill(book, t.security_id, "SELL", None)
        if sold is None:
            return None
        px = sold[0]
        if px >= float(t.target_price) * 0.98:
            status, why = "target_hit", "OCO target leg"
        elif px < float(t.entry_price):
            status, why = "sl_hit", "OCO stop-loss leg"
        else:
            status, why = "closed", "Trailed stop hit in profit"
        _close(t, px, status, why)
        return {"event": status, "price": px}
    if st in ("CANCELLED", "EXPIRED", "REJECTED"):
        t.sl_order_id = ""
        t.protection_note = f"Protective OCO was {st.lower()}; re-placing"
        prot = await place_protection(db, client, t)
        return {"event": "protection", "state": prot["state"]}
    if ltp and ltp < float(t.sl_price) * (1 - SL_LIMIT_BUFFER):
        t.protection_note = "Price is below the stop-loss limit: the SL may not have filled. Exit on Dhan now."
        return {"event": "sl_gap", "price": ltp}
    return None


# ── management advice (end of day) ────────────────────────────────────────

def surveillance_advice(info: Optional[dict], status: str = "open") -> Optional[dict]:
    """Advice when a held (or pending) stock is on an NSE surveillance list."""
    from backend.services.swing import nse_data

    if not info:
        return None
    label = nse_data.surveillance_label(info)
    if status == "pending":
        if nse_data.surveillance_tradeable(info):
            return {"action": "surveillance", "severity": "medium",
                    "reason": f"Now under NSE {label}: the entry is still allowed, but consider a smaller size."}
        return {"action": "cancel_entry", "severity": "high",
                "reason": f"Now under NSE {label}: cancel the pending entry (price band / settlement restrictions)."}
    if nse_data.surveillance_tradeable(info):
        return {"action": "surveillance", "severity": "medium",
                "reason": f"Added to NSE {label}: 100% margin; if it escalates the price band tightens. "
                          "Keep the stop tight and consider booking partial."}
    return {"action": "exit", "severity": "high",
            "reason": f"Under NSE {label}: tighter circuit limits can stop you from exiting at the stop-loss. "
                      "Exit or book most of the position while it trades freely."}


def advise(trade: Trade, df: Optional[pd.DataFrame], today: date, event_days: Optional[int] = None,
           surveillance: Optional[dict] = None) -> dict:
    """Pure: advice for an open trade from its daily candles."""
    if trade.status == "pending":
        sv = surveillance_advice(surveillance, "pending")
        return {"actions": [sv] if sv else [], "r": None}
    if df is None or len(df) < 25 or trade.status != "open":
        sv = surveillance_advice(surveillance)
        return {"actions": [sv] if sv else [], "r": None}
    entry, sl0 = float(trade.entry_price), float(trade.initial_sl or trade.sl_price)
    risk = max(1e-6, entry - sl0)
    c, last = df["close"], float(df["close"].iloc[-1])
    r_now = (last - entry) / risk
    peak = max(float(trade.peak_price or entry), float(df["high"].iloc[-1]))
    r_peak = (peak - entry) / risk
    cur_sl = float(trade.sl_price)
    a = float(atr(df, 14).iloc[-1])
    acts: list[dict] = []
    since = df[df["timestamp"].dt.date >= trade.entry_date] if trade.entry_date else df.tail(1)
    held = max(0, len(since) - 1)

    def raise_sl(level: float, why: str):
        level = _tick(level)
        if level > cur_sl * 1.001 and level < last:
            acts.append({"action": "move_sl", "new_sl": level, "reason": why, "severity": "info"})

    if held <= 3 and last < entry * 0.98 and len(since) >= 2:
        acts.append({"action": "exit", "reason": "Failed breakout: closed back below the entry within 3 sessions. "
                                                 "Cut it small; the setup is broken.", "severity": "high"})
    s50 = sma(c, 50).iloc[-1]
    v50 = df["volume"].tail(50).mean()
    if pd.notna(s50) and last < s50 and float(df["volume"].iloc[-1]) >= 1.5 * v50:
        acts.append({"action": "exit", "reason": "Closed below the 50-DMA on heavy volume (institutional selling)",
                     "severity": "high"})
    if not trade.t1_done and trade.t1_price and peak >= float(trade.t1_price):
        acts.append({"action": "book_partial", "qty": max(1, int(trade.quantity or 0) // 2),
                     "reason": f"T1 (2R) ₹{trade.t1_price:,.2f} reached: book half, let the rest run risk-free",
                     "severity": "medium"})
    if r_peak >= 1.5:
        raise_sl(entry, "Up 1.5R: move the stop to breakeven, this trade can no longer lose")
    if r_peak >= 2:
        span = 10 if trade.setup_type == "FLAG" else 21
        trail = float(ema(c, span).iloc[-1]) - 0.5 * a
        raise_sl(max(entry, trail), f"Trail under the {span}-EMA minus ½ ATR")
    if held >= 10 and r_now < 0.5 and not any(x["action"] == "exit" for x in acts):
        acts.append({"action": "exit", "reason": f"Time stop: {held} sessions and only {r_now:+.1f}R. "
                                                 "Free the capital for a stronger setup.", "severity": "medium"})
    sv = surveillance_advice(surveillance)
    if sv and not (sv["action"] == "exit" and any(x["action"] == "exit" for x in acts)):
        acts.append(sv)
    if event_days is not None and event_days <= 2:
        acts.append({"action": "tighten", "reason": f"Results in {event_days} day(s): book partial or tighten the stop "
                                                    "to avoid a gap", "severity": "medium"})
    best_sl = max([x["new_sl"] for x in acts if x["action"] == "move_sl"], default=None)
    acts = [x for x in acts if x["action"] != "move_sl" or x["new_sl"] == best_sl]
    return {"actions": acts, "r": round(r_now, 2), "r_peak": round(r_peak, 2), "held": held,
            "as_of": str(df["timestamp"].iloc[-1].date())}


async def manage_eod(db: Session, client, store, intel: Optional[dict] = None, today: Optional[date] = None) -> list[dict]:
    from backend.services.swing import nse_data

    today = today or date.today()
    intel = intel or nse_data.load_market_intel()
    s = get_settings()
    out = []
    for t in swing_trades(db, ("open", "pending")):
        df = store.load(t.security_id) if t.status == "open" else None
        ev = nse_data.next_event(intel, t.symbol, today, 5)
        adv = advise(t, df, today, ev["days"] if ev else None, nse_data.surveillance_info(intel, t.symbol))
        _set_advice(t, **adv)
        if s.get("auto_trail"):
            mv = next((x for x in adv["actions"] if x["action"] == "move_sl"), None)
            if mv:
                try:
                    await apply_sl(db, client, t, mv["new_sl"])
                except HTTPException as e:
                    logger.warning("auto-trail failed for %s: %s", t.symbol, e.detail)
        out.append({"trade_id": t.id, "symbol": t.symbol, **adv})
    db.commit()
    urgent = [o for o in out if any(x["severity"] == "high" for x in o["actions"])]
    for o in urgent:
        msg = "; ".join(x["reason"] for x in o["actions"] if x["severity"] == "high")
        await _alert(f"🔴 Swing <b>{o['symbol']}</b>: {msg}")
    return out


# ── actions ───────────────────────────────────────────────────────────────

async def apply_sl(db: Session, client, trade: Trade, new_sl: float, *, allow_lower: bool = False) -> dict:
    if trade.status != "open":
        raise HTTPException(400, "Only open trades have a stop to move")
    new_sl = _tick(new_sl)
    if new_sl <= 0 or new_sl >= float(trade.target_price):
        raise HTTPException(400, "Stop must be above 0 and below the target")
    if new_sl < float(trade.sl_price) and not allow_lower:
        raise HTTPException(400, "Refusing to LOWER the stop (that only increases risk)")
    if trade.entry_mode != "paper":
        if not trade.sl_order_id:
            raise HTTPException(409, "No protective GTT on Dhan yet")
        res = await client.modify_forever_order(
            trade.sl_order_id, order_flag="OCO", leg_name="STOP_LOSS_LEG", order_type="LIMIT",
            quantity=int(trade.quantity), price=_tick(new_sl * (1 - SL_LIMIT_BUFFER)), trigger_price=new_sl,
        )
        if osf.is_error(res):
            raise HTTPException(400, f"Dhan rejected the stop change: {osf.error_detail(res)}")
    trade.sl_price = new_sl
    _set_advice(trade, actions=[x for x in _advice(trade).get("actions", []) if x.get("action") != "move_sl"])
    db.commit()
    return {"ok": True, "sl": new_sl}


async def book_partial(db: Session, client, trade: Trade, qty: int, price: Optional[float] = None) -> dict:
    from backend.services.market_calendar import is_market_open

    qty = int(qty)
    if trade.status != "open" or qty < 1 or qty >= int(trade.quantity or 0):
        raise HTTPException(400, "Partial quantity must be at least 1 and less than the open quantity")
    remaining = int(trade.quantity) - qty
    if trade.entry_mode == "paper":
        px = float(price or 0) or float((await live_prices(client, [trade.security_id])).get(trade.security_id) or 0)
        if px <= 0:
            raise HTTPException(400, "No price available for the partial exit")
    else:
        if not is_market_open():
            raise HTTPException(400, "Market is closed")
        async with osf.single_flight(f"swing-exit:{trade.id}"):
            ok, detail = await osf.cancel_gtt_checked(client, trade.sl_order_id)
            if not ok:
                raise HTTPException(409, f"Could not cancel the protective GTT: {detail}. Nothing sold.")
            trade.sl_order_id = ""
            db.commit()
            res = await client.place_order(security_id=trade.security_id, exchange_segment=SEG, transaction_type="SELL",
                                           product_type=PRODUCT, order_type="MARKET", quantity=qty, price=0)
            if osf.is_error(res):
                trade.protection_note = "Partial sell FAILED and the GTT was cancelled: re-placing protection"
                db.commit()
                await place_protection(db, client, trade)
                raise HTTPException(400, f"Sell failed: {osf.error_detail(res)}")
            px = float((await live_prices(client, [trade.security_id])).get(trade.security_id) or trade.t1_price or 0)
    trade.pnl = round(float(trade.pnl or 0) + (px - float(trade.entry_price)) * qty, 2)
    trade.quantity = remaining
    trade.t1_done = True
    trade.sl_price = max(float(trade.sl_price), float(trade.entry_price))      # rest is risk-free
    trade.notes = ((trade.notes or "") + f" | Booked {qty} @ {px:.2f} on {date.today()}")[:2000]
    db.commit()
    if trade.entry_mode != "paper":
        await place_protection(db, client, trade)
    return {"ok": True, "booked": qty, "price": round(px, 2), "remaining": remaining, "sl": trade.sl_price}


async def exit_trade(db: Session, client, trade: Trade, price: Optional[float] = None) -> dict:
    from backend.services.market_calendar import is_market_open

    if trade.status not in OPEN_STATES:
        raise HTTPException(400, f"Trade is already {trade.status}")
    if trade.status == "pending":
        if trade.entry_mode == "gtt" and trade.buy_order_id:
            ok, detail = await osf.cancel_gtt_checked(client, trade.buy_order_id)
            if not ok:
                raise HTTPException(409, detail)
        elif trade.entry_mode == "limit" and trade.buy_order_id:
            st, _ = osf.parse_order_status(await client.get_order_by_id(trade.buy_order_id))
            if st == osf.FILLED:
                raise HTTPException(409, "The entry already filled; refresh and exit the open position instead")
            if st not in osf.DEAD_STATUSES:
                res = await client.cancel_order(trade.buy_order_id)
                if osf.is_error(res):
                    raise HTTPException(409, f"Could not cancel the entry: {osf.error_detail(res)}")
        trade.status, trade.exit_reason, trade.exit_date = "cancelled", "Entry cancelled", date.today()
        db.commit()
        return {"ok": True, "status": "cancelled"}

    ltp = (await live_prices(client, [trade.security_id])).get(trade.security_id)
    if trade.entry_mode == "paper":
        px = float(price or 0) or float(ltp or 0)
        if px <= 0:
            raise HTTPException(400, "No price available; enter the exit price")
        _close(trade, px, "closed", "Manual exit")
        db.commit()
        return {"ok": True, "status": "closed", "price": px}
    if not is_market_open():
        raise HTTPException(400, "Market is closed. Exit on Dhan, or wait for market hours.")
    async with osf.single_flight(f"swing-exit:{trade.id}"):
        ok, detail = await osf.cancel_gtt_checked(client, trade.sl_order_id)
        if not ok:
            raise HTTPException(409, f"{detail}. Nothing sold; exit on Dhan directly.")
        trade.sl_order_id = ""
        db.commit()
        res = await client.place_order(security_id=trade.security_id, exchange_segment=SEG, transaction_type="SELL",
                                       product_type=PRODUCT, order_type="MARKET", quantity=int(trade.quantity), price=0)
        if osf.is_error(res):
            trade.protection_note = "EXIT FAILED and the GTT was cancelled: position is UNPROTECTED, exit on Dhan now"
            db.commit()
            raise HTTPException(400, f"Sell failed: {osf.error_detail(res)}. The position is UNPROTECTED.")
        _close(trade, float(ltp or trade.entry_price), "closed", "Manual exit")
        trade.notes = ((trade.notes or "") + f" | EXIT {res.get('orderId', '?')}")[:2000]
        db.commit()
        return {"ok": True, "status": "closed", "price": trade.exit_price}


async def _alert(text: str) -> None:
    try:
        from backend.services.telegram_notifier import send_telegram_message, telegram_is_configured

        if telegram_is_configured():
            await send_telegram_message(text)
    except Exception as e:
        logger.debug("telegram alert failed: %s", e)
