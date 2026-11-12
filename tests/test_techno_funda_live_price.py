"""Live price handling: today's provisional candle, quote parsing, price info and live-price ratios."""

from datetime import date, datetime

import pandas as pd

from backend.services import techno_funda_sources as src
from backend.services.techno_funda_service import _price_info

QUOTE = {"data": {"NSE_EQ": {"157": {"last_price": 8482.5, "last_trade_time": "12/11/2026 11:46:22", "volume": 108956,
                                     "ohlc": {"open": 8537.5, "close": 8604, "high": 8537.5, "low": 8479},
                                     "52_week_high": 9070.5, "52_week_low": 6696.5}}}}


def _daily(last_day="2026-11-11", close=8604.0):
    days = pd.to_datetime(["2026-11-06", "2026-11-09", last_day])
    return pd.DataFrame({"timestamp": days, "open": [8356, 8499, 8595], "high": [8481, 8575, 8604],
                         "low": [8310, 8457, 8477], "close": [8446, 8549.5, close], "volume": [4e5, 5e5, 4.3e5]})


def test_parse_dhan_quote():
    q = src.parse_dhan_quote(QUOTE, "NSE_EQ", "157")
    assert q["ltp"] == 8482.5 and q["prev_close"] == 8604 and q["open"] == 8537.5
    assert q["ts"] == datetime(2026, 11, 12, 11, 46, 22)
    assert src.parse_dhan_quote({"data": {}}, "NSE_EQ", "157") is None


def test_live_candle_appended_during_session():
    df, added = src.merge_live_candle(_daily(), src.parse_dhan_quote(QUOTE, "NSE_EQ", "157"))
    assert added and len(df) == 4
    last = df.iloc[-1]
    assert last["timestamp"] == pd.Timestamp("2026-11-12") and last["close"] == 8482.5
    assert last["high"] >= last["open"] and last["low"] <= last["close"]


def test_official_candle_wins_after_close():
    # once Dhan publishes today's daily candle, the quote must not add a duplicate
    df, added = src.merge_live_candle(_daily(last_day="2026-11-12", close=8490.0), src.parse_dhan_quote(QUOTE, "NSE_EQ", "157"))
    assert not added and df["close"].iloc[-1] == 8490.0


def test_price_info_uses_live_quote_and_previous_official_close():
    df, _ = src.merge_live_candle(_daily(), src.parse_dhan_quote(QUOTE, "NSE_EQ", "157"))
    df.attrs["live"] = {**src.parse_dhan_quote(QUOTE, "NSE_EQ", "157"), "source": "Dhan live quote"}
    raw = {"profile": {"data": {"price_metrics": {"price": 8485}}}}
    pi = _price_info(df, raw, "Dhan historical")
    assert pi["price"] == 8482.5 and pi["is_quote"]
    assert pi["prev_close"] == 8604 and pi["prev_close_date"] == "2026-11-11"
    assert pi["change"] == -121.5 and pi["change_pct"] == -1.41
    assert pi["warnings"] == []


def test_price_info_flags_stale_close_and_disagreeing_sources(monkeypatch):
    import backend.services.market_calendar as mc

    monkeypatch.setattr(mc, "is_market_open", lambda *a: True)
    raw = {"profile": {"data": {"price_metrics": {"price": 9000}}}}
    pi = _price_info(_daily(), raw, "Dhan historical")       # no live quote available
    assert pi["price"] == 8604.0 and not pi["is_quote"]
    assert any("last daily close" in w for w in pi["warnings"])
    assert any("differs" in w for w in pi["warnings"])


def test_yahoo_gap_detection(monkeypatch):
    import backend.services.market_calendar as mc

    monkeypatch.setattr(mc, "today_ist", lambda: date(2026, 11, 12))
    yahoo_like = pd.DataFrame({"timestamp": pd.to_datetime(["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-12"]),
                               "close": [1, 2, 3, 4]})
    gaps = src.missing_sessions(yahoo_like, lookback_days=8)
    assert "2026-11-11" in gaps and "2026-11-08" in gaps   # Yahoo had no 11 Nov (and no Muhurat) candle


def test_fundamentals_rescaled_to_live_price():
    from backend.services.techno_funda_fundamental import analyze_fundamentals
    from tests.test_techno_funda_sources import _page

    raw = src.parse_screener_html(_page(), "ACME")          # Screener price 500, P/E 18, mcap 9000
    f = analyze_fundamentals(raw, live_price=450)
    v = f["valuation"]
    assert v["price"] == 450 and v["price_basis"] == "live"
    assert abs(v["pe"] - 16.2) < 0.01 and abs(v["market_cap_cr"] - 8100) < 0.01


def test_yahoo_gap_hides_wrong_day_change(monkeypatch):
    """Yahoo had no 11-Nov candle: the change must not be computed against 9-Nov's close."""
    import backend.services.market_calendar as mc

    monkeypatch.setattr(mc, "is_market_open", lambda *a: True)
    df = pd.DataFrame({"timestamp": pd.to_datetime(["2026-11-06", "2026-11-09", "2026-11-12"]),
                       "open": [1, 1, 1], "high": [1, 1, 1], "low": [1, 1, 1], "close": [8446.0, 8549.5, 8482.5], "volume": [1, 1, 1]})
    df.attrs["live"] = {"ltp": 8482.5, "ts": datetime(2026, 11, 12, 11, 52), "source": "Yahoo Finance (can lag by up to ~15 minutes)"}
    pi = _price_info(df, {}, "Yahoo")
    assert pi["price"] == 8482.5 and pi["delayed"] and not pi["is_live"]
    assert pi["change"] is None and pi["prev_close"] is None
    assert any("2026-11-11 is missing" in w for w in pi["warnings"])
