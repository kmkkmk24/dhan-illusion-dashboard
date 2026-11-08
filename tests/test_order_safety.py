"""Live-order safety: OCO protection, fill gating, checked cancels, idempotency, target monitor."""

import asyncio
from datetime import date, timedelta

import pytest

import backend.models.tables as T
from backend.api import index_trading, scanner
from backend.services import order_safety as osf
from conftest import make_app


@pytest.fixture
def http(SessionLocal, fake_dhan, monkeypatch):
    monkeypatch.setattr(scanner, "DhanClient", fake_dhan)
    monkeypatch.setattr(index_trading, "DhanClient", fake_dhan)
    monkeypatch.setattr(osf, "wait_for_fill", lambda *a, **k: asyncio.sleep(0))
    return make_app(SessionLocal, scanner.router, index_trading.router)


@pytest.fixture
def body(signal):
    return dict(signal_id=signal.id, option_security_id="X1", strike=1500, side="CE",
                expiry=(date.today() + timedelta(days=10)).isoformat(), lots=1,
                limit_price=10, sl_trigger_price=8, target_price=15, lot_size=50)


def place(http, body, **over):
    return http.post("/api/signals/place-trade", json={**body, **over})


# ── /place-trade ──

@pytest.mark.parametrize("over", [{"expiry": "bad"}, {"sl_trigger_price": 12}, {"target_price": 9}, {"side": "XX"}])
def test_invalid_input_rejected_before_any_order(http, body, fake_dhan, over):
    assert place(http, body, **over).status_code == 400
    assert fake_dhan.calls == []


def test_filled_buy_gets_single_oco(http, body, fake_dhan):
    r = place(http, body)
    assert r.status_code == 200 and r.json()["protection"]["state"] == "protected"
    gtts = [c[1] for c in fake_dhan.calls if c[0] == "forever"]
    assert len(gtts) == 1
    assert gtts[0]["order_flag"] == "OCO"
    assert gtts[0]["trigger_price"] == 15 and gtts[0]["trigger_price1"] == 8


def test_duplicate_submit_rejected(http, body, fake_dhan):
    assert place(http, body).status_code == 200
    fake_dhan.calls = []
    assert place(http, body).status_code == 409
    assert fake_dhan.calls == []


def test_unfilled_buy_recorded_without_gtt_then_protected_after_fill(http, body, fake_dhan, SessionLocal):
    fake_dhan.buy_status = "PENDING"
    r = place(http, body)
    d = r.json()
    assert r.status_code == 200 and d["trade_id"]
    assert d["protection"]["state"] == "awaiting_fill"
    assert "forever" not in fake_dhan.kinds()

    fake_dhan.buy_status = "TRADED"
    out = asyncio.run(osf.ensure_protection_all(SessionLocal(), fake_dhan()))
    assert {"trade_id": d["trade_id"], "state": "protected"}.items() <= next(
        o for o in out if o["trade_id"] == d["trade_id"]).items()


def test_rejected_buy_marks_trade_cancelled(http, body, fake_dhan, SessionLocal):
    fake_dhan.buy_status = "REJECTED"
    d = place(http, body).json()
    s = SessionLocal()
    assert s.get(T.Trade, d["trade_id"]).status == "cancelled"
    assert "forever" not in fake_dhan.kinds()


def test_gtt_failure_after_fill_still_records_trade(http, body, fake_dhan):
    fake_dhan.fail_forever = True
    r = place(http, body)
    d = r.json()
    assert r.status_code == 200 and d["trade_id"]
    assert "UNPROTECTED" in d["message"]


# ── close / exit-now ──

def test_close_refuses_when_gtt_still_live(http, body, fake_dhan, SessionLocal):
    tid = place(http, body).json()["trade_id"]
    fake_dhan.fail_cancel = True
    assert http.post(f"/api/signals/trades/{tid}/close?reason=closed").status_code == 409
    assert SessionLocal().get(T.Trade, tid).status == "open"

    fake_dhan.fail_cancel = False
    assert http.post(f"/api/signals/trades/{tid}/close?reason=closed").status_code == 200
    assert "cancel_forever" in fake_dhan.kinds()


@pytest.fixture
def market_open(monkeypatch):
    monkeypatch.setattr("backend.services.market_calendar.is_market_open", lambda *a, **k: True)


def test_exit_now_sells_nothing_if_gtt_cancel_fails(http, body, fake_dhan, market_open):
    tid = place(http, body).json()["trade_id"]
    fake_dhan.calls = []
    fake_dhan.fail_cancel = True
    assert http.post(f"/api/signals/trades/{tid}/exit-now").status_code == 409
    assert "place_order" not in fake_dhan.kinds()


def test_exit_now_cancels_gtt_before_selling(http, body, fake_dhan, market_open):
    tid = place(http, body).json()["trade_id"]
    fake_dhan.calls = []
    assert http.post(f"/api/signals/trades/{tid}/exit-now").status_code == 200
    k = fake_dhan.kinds()
    assert k.index("cancel_forever") < k.index("place_order")


def test_exit_now_cancels_unfilled_buy_instead_of_selling(http, body, fake_dhan, market_open, SessionLocal):
    fake_dhan.buy_status = "PENDING"
    tid = place(http, body).json()["trade_id"]
    fake_dhan.calls = []
    r = http.post(f"/api/signals/trades/{tid}/exit-now")
    assert r.status_code == 200
    assert "cancel_order" in fake_dhan.kinds() and "place_order" not in fake_dhan.kinds()
    assert SessionLocal().get(T.Trade, tid).status == "cancelled"


def test_exit_now_refused_when_market_closed(http, body, monkeypatch):
    tid = place(http, body).json()["trade_id"]
    monkeypatch.setattr("backend.services.market_calendar.is_market_open", lambda *a, **k: False)
    assert http.post(f"/api/signals/trades/{tid}/exit-now").status_code == 400


# ── manual index trades ──

def test_plan_parse_survives_trailing_text():
    plan = index_trading._parse_manual_plan(
        'manual-index:{"executed_qty":50,"t1_done":true,"t1_qty":50,"t2_qty":50,"t1_price":12,"t2_price":14}'
        " | sl-updated",
        quantity=100, lot_size=50)
    assert plan["executed_qty"] == 50 and plan["t1_done"] is True


@pytest.fixture
def manual_trade(db):
    t = T.Trade(security_id="OPT1", symbol="NIFTY 50", trade_type="option", option_type="CE", strike_price=24000,
                expiry_date=date.today() + timedelta(days=3), entry_price=100, sl_price=80, quantity=100,
                lot_size=50, status="open", buy_order_id="B1", sl_order_id="G0", entry_date=date.today(),
                notes=index_trading._manual_plan_to_notes({
                    "strategy": "manual-index", "executed_qty": 0, "t1_price": 105, "t1_qty": 50,
                    "t1_done": False, "t2_price": 200, "t2_qty": 50, "t2_done": False}))
    db.add(t)
    db.commit()
    return t


@pytest.fixture
def monitor_env(monkeypatch, fake_dhan):
    async def ltps(rows):
        for r in rows:
            r["live_option_ltp"] = 110.0

    monkeypatch.setattr(index_trading, "DhanClient", fake_dhan)
    monkeypatch.setattr(index_trading, "_market_open_now", lambda: True)
    monkeypatch.setattr(index_trading, "_attach_live_option_ltps", ltps)


def test_concurrent_monitor_sells_t1_once_and_reprotects(manual_trade, monitor_env, fake_dhan, SessionLocal):
    async def two():
        return await asyncio.gather(index_trading.run_manual_monitor(SessionLocal()),
                                    index_trading.run_manual_monitor(SessionLocal()))

    asyncio.run(two())
    sells = [c[1] for c in fake_dhan.calls if c[0] == "place_order"]
    assert len(sells) == 1 and sells[0]["quantity"] == 50
    k = fake_dhan.kinds()
    assert k.index("cancel_forever") < k.index("place_order")
    new_sl = [c[1] for c in fake_dhan.calls if c[0] == "forever"]
    assert len(new_sl) == 1 and new_sl[0]["quantity"] == 50

    t = SessionLocal().get(T.Trade, manual_trade.id)
    plan = index_trading._parse_manual_plan(t.notes, quantity=100, lot_size=50)
    assert plan["executed_qty"] == 50 and plan["t1_done"]


def test_monitor_skips_sell_when_sl_cancel_fails(manual_trade, monitor_env, fake_dhan, SessionLocal):
    fake_dhan.fail_cancel = True
    fake_dhan.forever_book = [{"orderId": "G0", "orderStatus": "PENDING"}]
    result = asyncio.run(index_trading.run_manual_monitor(SessionLocal()))
    assert "place_order" not in fake_dhan.kinds()
    assert any(e["event"] == "exit_skipped" for e in result["events"])


def test_ensure_protection_uses_remaining_qty_for_manual_trades(db, fake_dhan):
    t = T.Trade(security_id="OPT2", symbol="NIFTY 50", trade_type="option", option_type="CE", quantity=100,
                lot_size=50, sl_price=80, status="open", buy_order_id="B2", sl_order_id="",
                notes=index_trading._manual_plan_to_notes({"strategy": "manual-index", "executed_qty": 50}))
    db.add(t)
    db.commit()
    r = asyncio.run(osf.ensure_protection(db, fake_dhan(), t))
    gtt = [c[1] for c in fake_dhan.calls if c[0] == "forever"][0]
    assert r["state"] == "protected" and gtt["order_flag"] == "SINGLE" and gtt["quantity"] == 50


def test_parse_order_status_shapes():
    assert osf.parse_order_status([{"orderStatus": "traded", "filledQty": 25}]) == ("TRADED", 25)
    assert osf.parse_order_status({"orderStatus": "TRADED", "quantity": 75}) == ("TRADED", 75)
    assert osf.parse_order_status(None) == (None, 0)
