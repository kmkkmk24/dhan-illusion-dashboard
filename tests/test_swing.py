"""Swing engine: detectors, candle store, NSE parsing, evaluator, engine run, trades and API."""

import asyncio
import json
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

import backend.config as config_mod
import backend.models.tables as T
from backend.services.swing import evaluator as ev
from backend.services.swing import indicators as ind
from backend.services.swing import nse_data
from backend.services.swing.candles import CandleStore, adjust_for_corporate_action, previous_sessions
from backend.services.swing.regime import compute_regime
from backend.services.swing.settings import get_settings, position_size, save_settings
from backend.services.swing.setups import SetupParams, detect_flag, detect_ipo, detect_vcp, make_plan
from conftest import make_app
from swing_fixtures import END, downtrend_frame, flag_frame, frame, ipo_frame, sessions, vcp_frame


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    d = tmp_path / "data"
    d.mkdir()
    monkeypatch.setattr(config_mod, "DATA_DIR", d)
    from backend.services.swing import notify

    notify._alerted.clear()
    return d


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ── detectors ─────────────────────────────────────────────────────────────

def test_vcp_detected_with_tight_stop_and_contractions():
    df = vcp_frame()
    c = detect_vcp(df, ind.features(df), SetupParams())
    assert c and c.setup == "VCP" and c.status == "ready"
    assert c.metrics["contractions"][0] > c.metrics["contractions"][-1]          # contracting
    assert c.stop < c.entry and c.risk_pct <= 8 and not c.wide
    assert c.target1 == pytest.approx(c.entry + 2 * (c.entry - c.stop), abs=0.06)


def test_flag_and_ipo_detected_and_downtrend_rejected():
    p = SetupParams()
    f = flag_frame()
    c = detect_flag(f, ind.features(f), p)
    assert c and c.setup == "FLAG" and c.metrics["retrace_pct"] < 50 and c.smc["bos"]
    i = ipo_frame()
    c = detect_ipo(i, ind.features(i), p, listing_age_days=100, issue_price=280)
    assert c and c.setup == "IPO" and c.entry > c.levels["ath"]
    assert detect_ipo(i, ind.features(i), p, listing_age_days=900) is None             # too old for an IPO base
    assert detect_ipo(i, ind.features(i), p, listing_age_days=100, issue_price=500) is None  # below issue price
    d = downtrend_frame()
    fd = ind.features(d)
    assert detect_vcp(d, fd, p) is None and detect_flag(d, fd, p) is None


def test_breakout_day_is_triggered_and_extension_is_flagged():
    df = vcp_frame()
    base = detect_vcp(df, ind.features(df), SetupParams())
    for close, want in ((base.entry * 1.01, "triggered"), (base.entry * 1.08, "extended")):
        d = df.copy()
        d.loc[d.index[-1], ["close", "high"]] = [close, close * 1.003]
        d.loc[d.index[-1], "volume"] = 500_000
        c = detect_vcp(d, ind.features(d), SetupParams())
        assert c.status == want and c.entry == base.entry      # pivot from yesterday's structure


def test_plan_widens_noise_stops_and_flags_wide_risk():
    p = SetupParams()
    tight = make_plan(100, 99.8, atr=2.0, max_risk=8, p=p)
    assert tight["stop"] <= 98.0                          # at least 1 ATR
    wide = make_plan(100, 85, atr=2.0, max_risk=8, p=p)
    assert wide["wide"] and wide["risk_pct"] > 8
    alt = make_plan(100, 85, atr=2.0, max_risk=8, p=p, alt_stop=95)
    assert not alt["wide"] and alt["stop"] >= 94


def test_smc_helpers():
    df = frame([100] * 50 + [99, 98, 97, 101, 102] + [103] * 10)
    df.loc[57, "low"] = 90.0          # pierce the prior lows ...
    df.loc[57, "close"] = 103.0       # ... and reclaim
    sw = ind.liquidity_sweep(df, lookback=15, ref=40)
    assert sw and sw["low"] == 90.0
    g = frame([100, 100, 100, 110, 112, 113])
    gaps = ind.fair_value_gaps(g, 0)
    assert gaps and gaps[0]["bottom"] < gaps[0]["top"]
    assert ind.percentile_ranks({"a": 1, "b": 5, "c": None, "d": 3})["b"] == 99


# ── NSE parsing / candle store ────────────────────────────────────────────

BHAV = """SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER
AAA, EQ, 11-Nov-2026, 100.00, 101.00, 105.00, 100.50, 104.00, 104.20, 103.00, 1000000, 1042.00, 5000, 600000, 60.00
BBB, BE, 11-Nov-2026, 50.00, 50.00, 51.00, 49.00, 50.00, 50.10, 50.00, 1000, 0.50, 10, -, -
"""


def test_parse_bhavcopy_and_wrong_day_is_ignored():
    df = nse_data.parse_bhavcopy(BHAV, date(2026, 11, 11))
    a = df[df.symbol == "AAA"].iloc[0]
    assert a.close == 104.2 and a.turnover == pytest.approx(1042 * 1e5) and a.deliv_pct == 60
    assert df[df.symbol == "BBB"].iloc[0].deliv_pct != df[df.symbol == "BBB"].iloc[0].deliv_pct  # NaN
    assert nse_data.parse_bhavcopy(BHAV, date(2026, 11, 12)).empty     # holiday: NSE serves the old file


def test_store_appends_bhav_adjusts_split_and_detects_gap(tmp_path):
    st = CandleStore(tmp_path / "c")
    days = sessions(3)
    hist = frame([100, 101], end=days[1])
    bhav = pd.DataFrame([{"date": pd.Timestamp(days[2]), "prev_close": 101.0, "open": 102, "high": 103, "low": 101,
                          "close": 102.5, "volume": 5000, "deliv_pct": 55.0}])
    out, info = st.apply_bhav_rows("1", hist, bhav, previous_sessions([days[2]]))
    assert info["appended"] == 1 and out["deliv_pct"].iloc[-1] == 55.0 and info["adjusted"] is None
    split = bhav.assign(prev_close=50.5, open=51, high=52, low=50, close=51.5)     # 1:2 split on ex-date
    out, info = st.apply_bhav_rows("1", hist, split, previous_sessions([days[2]]))
    assert info["adjusted"] == pytest.approx(0.5, abs=0.01) and out["close"].iloc[1] == pytest.approx(50.5)
    gap_hist = frame([100], end=days[0])
    _, info = st.apply_bhav_rows("1", gap_hist, bhav, previous_sessions([days[2]]))
    assert info["gap"] and info["appended"] == 0
    st.save("1", out, symbol="AAA")
    st.flush_meta()
    assert CandleStore(tmp_path / "c").last_date("1") == days[2]
    assert adjust_for_corporate_action(hist, 0.5)["volume"].iloc[0] == 200_000


def test_market_intel_parsers():
    ev_rows = [{"symbol": "AAA", "purpose": "Financial Results", "date": "14-Nov-2026"},
               {"symbol": "AAA", "purpose": "Dividend", "date": "30-Dec-2026"}]
    intel = {"events": nse_data.parse_events(ev_rows)}
    nxt = nse_data.next_event(intel, "AAA", date(2026, 11, 12))
    assert nxt["days"] == 2 and nxt["purpose"] == "Financial Results"
    assert nse_data.next_event(intel, "AAA", date(2026, 11, 15)) is None          # Dec is beyond 21 days
    surv = nse_data.parse_surveillance({"longterm": {"data": [{"symbol": "XX", "survDesc": "LTASM"}]}},
                                       [{"symbol": "YY", "survDesc": "GSM"}])
    assert set(surv) == {"XX", "YY"}
    today = date.today().strftime("%d-%b-%Y")
    deals = nse_data.merge_deals({}, {"BULK_DEALS_DATA": [{"symbol": "AAA", "date": today, "buySell": "BUY",
                                                          "clientName": "SOME MF", "qty": "1000", "watp": "10"}]})
    assert nse_data.institutional_deals({"deals": deals}, "AAA")["buy_qty"] == 1000


# ── evaluator ─────────────────────────────────────────────────────────────

PLAN = {"entry": 100.0, "stop": 95.0, "target1": 110.0, "target2": 115.0}


def bars(rows):
    days = sessions(len(rows))
    return pd.DataFrame([{"timestamp": pd.Timestamp(d), "open": o, "high": h, "low": l, "close": c}
                         for d, (o, h, l, c) in zip(days, rows)])


def test_evaluator_win_after_partial_and_gap_fill():
    r = ev.evaluate_plan(PLAN, bars([(99, 99.5, 98, 99), (102, 104, 101, 103), (104, 111, 103, 110), (110, 116, 109, 115)]))
    assert r["status"] == "win" and r["fill"] == 102           # gapped above the entry: filled at the open
    assert r["t1_hit"] and r["r"] == pytest.approx(0.5 * (110 - 102) / 7 + 0.5 * (115 - 102) / 7, abs=0.01)


def test_evaluator_honest_losses():
    # stop and target touched the same day -> stop first
    r = ev.evaluate_plan(PLAN, bars([(100, 101, 99, 100), (100, 116, 94, 100)]))
    assert r["status"] == "loss" and r["r"] == pytest.approx(-1.0)
    # gap down through the stop fills at the open
    r = ev.evaluate_plan(PLAN, bars([(100, 101, 99, 100), (92, 93, 90, 91)]))
    assert r["exit_price"] == 92 and r["r"] < -1
    # stop before the trigger = invalidated, never a loss
    r = ev.evaluate_plan(PLAN, bars([(97, 98, 94, 95)]))
    assert r["status"] == "invalidated"
    # never triggered
    r = ev.evaluate_plan(PLAN, bars([(97, 98, 96, 97)] * 10), max_wait=10)
    assert r["status"] == "no_trigger"
    # T1 then back to breakeven
    r = ev.evaluate_plan(PLAN, bars([(100, 111, 99.5, 108), (108, 108, 99, 99)]))
    assert r["status"] == "win" and r["r"] == pytest.approx(0.5 * 10 / 5, abs=0.01)


def test_summary_and_edge():
    rows = [{"status": "win", "r": 2.0, "days_held": 5}] * 10 + [{"status": "loss", "r": -1.0, "days_held": 3}] * 6 + \
           [{"status": "no_trigger", "r": None}] * 4
    s = ev.summarize(rows)
    assert s["win_rate"] == 62.5 and s["profit_factor"] == pytest.approx(20 / 6, abs=0.01) and s["trigger_rate"] == 80.0
    assert ev.edge_verdict(s) == "positive"


# ── regime / settings ─────────────────────────────────────────────────────

def test_regime_labels():
    up = frame(np.linspace(100, 200, 260))
    assert compute_regime(up, {"above50_pct": 70, "new_highs": 30, "new_lows": 2})["label"] == "uptrend"
    down = frame(np.linspace(200, 100, 260))
    r = compute_regime(down, {"above50_pct": 15, "new_highs": 1, "new_lows": 40})
    assert r["label"] == "downtrend" and r["risk_mult"] == 0


def test_settings_validation_and_sizing():
    s = save_settings({"capital": 200000, "risk_per_trade_pct": 1})
    assert s["capital"] == 200000
    with pytest.raises(ValueError):
        save_settings({"risk_per_trade_pct": 10})
    z = position_size(100, 95, get_settings())
    assert z["qty"] == 400 and z["risk_amount"] == 2000
    capped = position_size(100, 99.5, get_settings())          # tiny stop -> capped by max position 20%
    assert capped["capped"] and capped["position_value"] <= 40000


# ── engine end-to-end ─────────────────────────────────────────────────────

FRAMES = {"101": ("VCPCO", vcp_frame), "102": ("FLAGCO", flag_frame), "103": ("IPOCO", ipo_frame),
          "104": ("DOWNCO", downtrend_frame)}


class FakeData:
    def __init__(self):
        self.frames = {sid: fn() for sid, (_, fn) in FRAMES.items()}
        self.frames["13"] = frame(np.linspace(20000, 26000, 400))
        self.hist_calls = []

    async def get_historical_daily_data(self, security_id, exchange_segment, instrument, from_date, to_date):
        self.hist_calls.append(security_id)
        df = self.frames[str(security_id)]
        ts = df["timestamp"].dt.date
        keep = (ts >= from_date) & (ts <= to_date)
        if security_id != "13":
            keep &= ts < END                    # Dhan: today's candle not available yet
        return df[keep].reset_index(drop=True)

    async def close(self):
        pass

    def bhav(self):
        rows = []
        for sid, (sym, _) in FRAMES.items():
            df = self.frames[sid]
            last, prev = df.iloc[-1], df.iloc[-2]
            rows.append({"symbol": sym, "series": "EQ", "date": pd.Timestamp(END), "prev_close": prev.close,
                         "open": last.open, "high": last.high, "low": last.low, "close": last.close,
                         "volume": 1_000_000, "turnover": 1e9, "deliv_pct": 50.0})
        return pd.DataFrame(rows)


def make_engine(db, tmp_path, data):
    from backend.services.swing.engine import SwingEngine

    for sid, (sym, _) in FRAMES.items():
        db.add(T.Instrument(security_id=sid, exchange="NSE", segment="E", symbol=sym + " LTD", trading_symbol=sym,
                            instrument_type="ES", isin=f"INE{sid}", sector="Nifty IT" if sid == "101" else None))
    db.commit()

    async def bhav_fetch(d, client=None):
        return data.bhav() if d == END else pd.DataFrame()

    async def intel():
        return {"events": {}, "surveillance": {}, "deals": {}}

    async def master():
        return {"IPOCO": {"isin": "INE103", "listed": (END - timedelta(days=100)).isoformat()}}

    return SwingEngine(db, dhan=data, store=CandleStore(tmp_path / "candles"), bhav_fetch=bhav_fetch,
                       intel_fetch=intel, master_fetch=master, today=END)


def test_engine_run_finds_ranks_persists_and_evaluates(db, tmp_path):
    data = FakeData()
    eng = make_engine(db, tmp_path, data)
    out = run(eng.run())
    assert out["ok"], out
    assert out["universe"]["liquid"] == 4 and out["scanned"] == 4
    rows = {(r.symbol, r.setup_type): r for r in db.query(T.SwingSetup).all()}
    assert {("VCPCO", "VCP"), ("FLAGCO", "FLAG"), ("IPOCO", "IPO")} <= set(rows)
    assert not any(sym == "DOWNCO" for sym, _ in rows)
    vcp = rows[("VCPCO", "VCP")]
    assert vcp.status == "ready" and vcp.rs_rating and json.loads(vcp.detail)["chart"]
    assert vcp.suggested_on == END and vcp.eval_status == "pending"      # plan frozen for accuracy tracking
    assert out["top_picks"] <= get_settings()["top_picks"]
    # today's row came from the bhavcopy (with delivery %), history from Dhan
    st = CandleStore(tmp_path / "candles")
    assert st.load("101")["deliv_pct"].iloc[-1] == 50.0

    # second run on the same day: no new Dhan back-fill
    calls = len(data.hist_calls)
    out2 = run(make_engine_again(db, tmp_path, data).run())
    assert out2["ok"] and len([c for c in data.hist_calls[calls:] if c != "13"]) == 0

    # the market moves: breakout then T2 -> evaluated as a win
    df = st.load("101")
    e, s = vcp.plan_entry, vcp.plan_stop
    risk = e - s
    nxt = sessions(1, END + timedelta(days=7))
    extra = pd.DataFrame([{"timestamp": pd.Timestamp(END + timedelta(days=1)), "open": e - 1, "high": e + 1,
                           "low": e - 2, "close": e + 0.5, "volume": 1e6, "deliv_pct": np.nan},
                          {"timestamp": pd.Timestamp(nxt[0]), "open": e + 1, "high": e + 3.2 * risk,
                           "low": e, "close": e + 3 * risk, "volume": 1e6, "deliv_pct": np.nan}])
    st.save("101", pd.concat([df, extra], ignore_index=True))
    eng3 = make_engine_again(db, tmp_path, data)
    eng3.store = st
    eng3.evaluate_suggestions(nxt[0])
    db.refresh(vcp)
    assert vcp.eval_status == "win" and vcp.result_r > 1.5


def make_engine_again(db, tmp_path, data):
    from backend.services.swing.engine import SwingEngine

    async def bhav_fetch(d, client=None):
        return pd.DataFrame()

    async def intel():
        return {"events": {}, "surveillance": {}, "deals": {}}

    async def master():
        return {}

    return SwingEngine(db, dhan=data, store=CandleStore(tmp_path / "candles"), bhav_fetch=bhav_fetch,
                       intel_fetch=intel, master_fetch=master, today=END)


def test_surveillance_and_earnings_block(db, tmp_path):
    data = FakeData()
    eng = make_engine(db, tmp_path, data)

    async def intel():
        return {"events": {"FLAGCO": [{"date": (END + timedelta(days=2)).isoformat(), "purpose": "Financial Results"}]},
                "surveillance": {"IPOCO": "ASM"}, "deals": {}}

    eng.intel_fetch = intel
    out = run(eng.run())
    assert out["universe"]["surveillance_excluded"] == 1
    syms = {r.symbol for r in db.query(T.SwingSetup).all()}
    assert "IPOCO" not in syms
    flag = db.query(T.SwingSetup).filter_by(symbol="FLAGCO").one()
    assert not flag.top_pick and any("gap risk" in w for w in json.loads(flag.warnings))


# ── trades ────────────────────────────────────────────────────────────────

class FakeBroker:
    def __init__(self):
        self.calls = []
        self.ltp = 100.0
        self.book = []
        self.gtt = {}

    async def close(self):
        pass

    async def get_market_quote_ltp(self, ids, seg):
        return {"data": {seg: {i: {"last_price": self.ltp} for i in ids}}}

    async def create_forever_order(self, **kw):
        oid = f"G{len(self.calls)}"
        self.calls.append(("forever", kw))
        self.gtt[oid] = "PENDING"
        return {"orderId": oid}

    async def modify_forever_order(self, oid, **kw):
        self.calls.append(("modify", oid, kw))
        return {"orderId": oid}

    async def cancel_forever_order(self, oid):
        self.calls.append(("cancel_forever", oid))
        self.gtt[oid] = "CANCELLED"
        return {"orderId": oid, "orderStatus": "CANCELLED"}

    async def get_forever_orders(self):
        return [{"orderId": k, "orderStatus": v} for k, v in self.gtt.items()]

    async def get_order_book(self):
        return self.book

    async def place_order(self, **kw):
        self.calls.append(("order", kw))
        return {"orderId": f"O{len(self.calls)}"}

    async def get_order_by_id(self, oid):
        return [{"orderStatus": "TRADED", "filledQty": 10}]

    async def cancel_order(self, oid):
        return {"orderId": oid}

    async def get_holdings(self):
        return getattr(self, "holdings", [])

    async def edis_inquire(self, isin):
        return {"isin": isin, "totalQty": 10, "aprvdQty": 0}


def _inst(db):
    db.add(T.Instrument(security_id="501", exchange="NSE", segment="E", symbol="ABC LTD", trading_symbol="ABC",
                        instrument_type="ES", isin="INE501"))
    db.commit()


def test_paper_trade_lifecycle(db):
    from backend.services.swing import trades as tr

    _inst(db)
    b = FakeBroker()
    b.ltp = 98
    res = run(tr.open_trade(db, b, {"security_id": "501", "mode": "paper", "qty": 10, "entry": 100, "stop": 95, "target": 115}))
    t = db.get(T.Trade, res["trade_id"])
    assert t.status == "pending" and t.trade_type == "swing"
    with pytest.raises(Exception):                     # duplicate on the same stock
        run(tr.open_trade(db, b, {"security_id": "501", "mode": "paper", "qty": 1, "entry": 100, "stop": 95, "target": 115}))
    b.ltp = 100.5
    run(tr.monitor(db, b))
    assert t.status == "open" and t.entry_date
    b.ltp = 94
    run(tr.monitor(db, b))
    assert t.status == "sl_hit" and t.pnl == pytest.approx(-60)


def test_live_gtt_entry_fill_protection_and_trail(db):
    from backend.services.swing import trades as tr

    _inst(db)
    b = FakeBroker()
    b.ltp = 97
    b.holdings = [{"securityId": "501", "totalQty": 5}]
    with pytest.raises(Exception) as held:            # already held outside the app
        run(tr.open_trade(db, b, {"security_id": "501", "mode": "gtt", "qty": 10, "entry": 100, "stop": 95, "target": 115}))
    assert "already hold" in str(held.value.detail)
    b.holdings = []
    res = run(tr.open_trade(db, b, {"security_id": "501", "mode": "gtt", "qty": 10, "entry": 100, "stop": 95, "target": 115}))
    kind, kw = b.calls[0]
    assert kw["transaction_type"] == "BUY" and kw["product_type"] == "CNC" and kw["trigger_price"] == 100
    t = db.get(T.Trade, res["trade_id"])
    b.gtt[t.buy_order_id] = "TRADED"
    b.book = [{"securityId": "501", "transactionType": "BUY", "orderStatus": "TRADED", "averageTradedPrice": 100.4,
               "filledQty": 10}]
    run(tr.monitor(db, b))
    assert t.status == "open" and t.entry_price == 100.4 and t.sl_order_id
    oco = [c for c in b.calls if c[0] == "forever" and c[1]["order_flag"] == "OCO"][0][1]
    assert oco["transaction_type"] == "SELL" and oco["product_type"] == "CNC" and oco["trigger_price1"] == 95
    assert "eDIS" in t.protection_note                   # 0 shares authorised -> warned
    with pytest.raises(Exception):
        run(tr.apply_sl(db, b, t, 90))                   # never lower the stop
    run(tr.apply_sl(db, b, t, 100.4))
    assert b.calls[-1][0] == "modify" and b.calls[-1][2]["leg_name"] == "STOP_LOSS_LEG" and t.sl_price == 100.4
    # GTT buy-stop refused when price is already above the entry
    db.add(T.Instrument(security_id="502", exchange="NSE", segment="E", symbol="X", trading_symbol="X", instrument_type="ES"))
    db.commit()
    b.ltp = 120
    with pytest.raises(Exception):
        run(tr.open_trade(db, b, {"security_id": "502", "mode": "gtt", "qty": 1, "entry": 100, "stop": 95, "target": 115}))


def test_risk_guard_rejects_oversized_trade(db):
    from backend.services.swing import trades as tr

    _inst(db)
    with pytest.raises(Exception) as e:
        run(tr.open_trade(db, FakeBroker(), {"security_id": "501", "mode": "paper", "qty": 10000, "entry": 100,
                                             "stop": 95, "target": 115}))
    assert "exceeds 3%" in str(e.value.detail)


def test_advice_failed_breakout_and_breakeven():
    from backend.services.swing.trades import advise

    df = frame(np.r_[np.linspace(80, 100, 60), [101, 97.5]])
    t = T.Trade(status="open", entry_price=100.0, sl_price=95.0, initial_sl=95.0, t1_price=110.0, target_price=115.0,
                quantity=10, entry_date=df["timestamp"].iloc[-2].date(), setup_type="VCP")
    acts = advise(t, df, END)["actions"]
    assert any(a["action"] == "exit" and "Failed breakout" in a["reason"] for a in acts)
    up = frame(np.r_[np.linspace(80, 100, 60), [104, 108, 109]])
    t.entry_date = up["timestamp"].iloc[-3].date()
    acts = advise(t, up, END)["actions"]
    mv = [a for a in acts if a["action"] == "move_sl"]
    assert mv and mv[0]["new_sl"] >= 100


# ── API ───────────────────────────────────────────────────────────────────

def test_api_overview_setups_settings_and_paper_trade(SessionLocal, tmp_path, monkeypatch):
    from backend.api import swing as api
    import backend.services.dhan_client as dc

    monkeypatch.setattr(dc, "DhanClient", FakeBroker)

    client = make_app(SessionLocal, api.router)
    db = SessionLocal()
    data = FakeData()
    run(make_engine(db, tmp_path, data).run())
    db.close()
    ov = client.get("/api/swing/overview").json()
    assert "counts" in ov and ov["regime"]["label"] in ("uptrend", "caution", "downtrend")
    rows = client.get("/api/swing/setups", params={"setup": "VCP"}).json()
    assert rows and rows[0]["sizing"]["qty"] > 0 and rows[0]["reasons"]
    full = client.get(f"/api/swing/setups/{rows[0]['id']}").json()
    assert len(full["chart"]) > 50
    assert client.put("/api/swing/settings", json={"risk_per_trade_pct": 9}).status_code == 400
    r = client.post("/api/swing/trades", json={"setup_id": rows[0]["id"], "mode": "paper", "qty": 5,
                                                "entry": rows[0]["entry"], "stop": rows[0]["stop"],
                                                "target": rows[0]["target2"], "fill_price": rows[0]["entry"]})
    assert r.status_code == 200 and r.json()["status"] == "open"
    lst = client.get("/api/swing/trades", params={"live": False}).json()
    assert lst[0]["setup"] == "VCP" and lst[0]["mode"] == "paper"
    acc = client.get("/api/swing/accuracy").json()
    assert acc["overall"]["suggested"] >= 1


# ── surveillance (ASM / GSM) ──────────────────────────────────────────────

ASM = {"longterm": {"data": [{"symbol": "LT1", "asmSurvIndicator": "Stage I", "survCode": "LTASM - I (13)", "survDesc": "LTASM I"},
                             {"symbol": "LT4", "asmSurvIndicator": "Stage IV", "survCode": "LTASM - IV (16)", "survDesc": "LTASM IV"},
                             {"symbol": "BOTH", "asmSurvIndicator": "Stage I", "survCode": "LTASM - I (13)", "survDesc": "LTASM I"}]},
       "shortterm": {"data": [{"symbol": "ST1", "asmSurvIndicator": "Stage I", "survCode": "STASM - I (1)", "survDesc": "STASM I"},
                              {"symbol": "BOTH", "asmSurvIndicator": "Stage I", "survCode": "STASM - I (1)", "survDesc": "STASM I"}]}}


def test_surveillance_stages_and_tradeability():
    surv = nse_data.parse_surveillance(ASM, [{"symbol": "G1", "survDesc": "GSM 0"}])
    intel = {"surveillance": surv}
    assert surv["LT1"] == {"kind": "ASM-LT", "stage": 1, "desc": "LTASM I"} and surv["LT4"]["stage"] == 4
    assert surv["BOTH"]["kind"] == "ASM-ST"                         # the stricter list wins
    ok = {s: nse_data.surveillance_tradeable(nse_data.surveillance_info(intel, s)) for s in ("LT1", "LT4", "ST1", "BOTH", "G1", "CLEAN")}
    assert ok == {"LT1": True, "LT4": False, "ST1": False, "BOTH": False, "G1": False, "CLEAN": True}
    old = {"surveillance": {"X": "Long Term Additional Surveillance Measure (LTASM) - Stage I"}}   # pre-upgrade cache
    assert nse_data.surveillance_tradeable(nse_data.surveillance_info(old, "X"))


def test_asm_stage1_stays_in_universe_with_warning(db, tmp_path):
    eng = make_engine(db, tmp_path, FakeData())

    async def intel():
        return {"events": {}, "deals": {}, "surveillance": {
            "VCPCO": {"kind": "ASM-LT", "stage": 1, "desc": "LTASM I"},
            "FLAGCO": {"kind": "ASM-LT", "stage": 2, "desc": "LTASM II"}}}

    eng.intel_fetch = intel
    out = run(eng.run())
    assert out["universe"]["surveillance_excluded"] == 1 and out["universe"]["surveillance_flagged"] == 1
    syms = {r.symbol for r in db.query(T.SwingSetup).all()}
    assert "FLAGCO" not in syms
    vcp = db.query(T.SwingSetup).filter_by(symbol="VCPCO").one()
    assert any("long-term ASM Stage 1" in w for w in json.loads(vcp.warnings))
    assert json.loads(vcp.detail)["surveillance"]["stage"] == 1


def test_open_and_pending_trades_warned_when_added_to_surveillance():
    from backend.services.swing.trades import advise

    df = frame(np.r_[np.linspace(80, 100, 60), [101, 102, 103]])
    t = T.Trade(status="open", entry_price=100.0, sl_price=95.0, initial_sl=95.0, t1_price=110.0, target_price=115.0,
                quantity=10, entry_date=df["timestamp"].iloc[-3].date(), setup_type="VCP")
    mild = advise(t, df, END, surveillance={"kind": "ASM-LT", "stage": 1, "desc": ""})["actions"]
    assert any(a["action"] == "surveillance" and a["severity"] == "medium" for a in mild)
    harsh = advise(t, df, END, surveillance={"kind": "GSM", "stage": None, "desc": ""})["actions"]
    assert any(a["action"] == "exit" and a["severity"] == "high" and "GSM" in a["reason"] for a in harsh)
    assert not advise(t, df, END)["actions"] or all(a["action"] != "surveillance" for a in advise(t, df, END)["actions"])
    t.status = "pending"
    pend = advise(t, None, END, surveillance={"kind": "ASM-ST", "stage": 1, "desc": ""})["actions"]
    assert pend[0]["action"] == "cancel_entry"
