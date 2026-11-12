"""TechnoFunda engines: technical indicators on synthetic candles, fundamental parsing and scoring,
Tapetide statement splitting / quota detection, and the disk-cache path of the service."""

import asyncio
import math

import numpy as np
import pandas as pd
import pytest

from backend.services import techno_funda_service as svc_mod
from backend.services.techno_funda_fundamental import analyze_fundamentals, cagr, series
from backend.services.techno_funda_technical import analyze_technicals, rsi
from backend.services.techno_funda_service import TapetideBudget, TechnoFundaService, _split_financials


def _candles(n=420, drift=0.0015, seed=1, start=100.0):
    rng = np.random.default_rng(seed)
    rets = drift + rng.normal(0, 0.012, n)
    close = start * np.exp(np.cumsum(rets))
    high = close * (1 + np.abs(rng.normal(0, 0.006, n)))
    low = close * (1 - np.abs(rng.normal(0, 0.006, n)))
    open_ = np.r_[close[0], close[:-1]]
    vol = rng.integers(80_000, 120_000, n).astype(float)
    ts = pd.bdate_range("2024-06-03", periods=n)
    return pd.DataFrame({"timestamp": ts, "open": open_, "high": np.maximum(high, open_), "low": np.minimum(low, open_),
                         "close": close, "volume": vol})


# ── technical ──

def test_rsi_bounds_and_trend():
    up = pd.Series(np.linspace(100, 200, 60))
    assert rsi(up).iloc[-1] == pytest.approx(100.0)
    s = rsi(_candles()["close"]).dropna()
    assert ((s >= 0) & (s <= 100)).all()


def test_uptrend_scores_higher_than_downtrend():
    bench = _candles(drift=0.0003, seed=7, start=20000)
    up = analyze_technicals(_candles(drift=0.002), bench)
    down = analyze_technicals(_candles(drift=-0.002), bench)
    assert up["available"] and down["available"]
    assert up["score"] > down["score"] + 20
    assert up["trend"]["stage"]["stage"] == 2
    assert down["trend"]["stage"]["stage"] == 4
    assert up["trend"]["trend_template"]["total"] == 7
    assert up["relative_strength"]["available"] and up["relative_strength"]["outperformance"]["6M"] > 0
    assert set(up["pillars"]) == {"trend", "momentum", "relative_strength", "volume", "risk"}


def test_levels_and_plan_are_consistent():
    t = analyze_technicals(_candles(drift=0.001, seed=3))
    last = t["last_close"]
    assert all(s["price"] < last for s in t["levels"]["supports"])
    assert all(r["price"] > last for r in t["levels"]["resistances"])
    p = t["plan"]
    assert p["available"] and p["stop_loss"] < last < p["target_1"] <= p["target_2"]
    assert p["target_1_rr"] > 0


def test_short_history_degrades_gracefully():
    t = analyze_technicals(_candles(n=90))
    assert t["available"]
    assert t["trend"]["trend_template"]["total"] == 0  # no 200-DMA yet
    assert any(c["status"] == "na" for c in t["checks"]["trend"])
    assert analyze_technicals(_candles(n=10))["available"] is False


# ── fundamental ──

def _stmt(section, rows, periods):
    return {"data": [{"section": section, "periods": periods,
                      "data": {k: dict(zip(periods, v)) for k, v in rows.items()}}]}


YEARS = ["Mar 2021", "Mar 2022", "Mar 2023", "Mar 2024", "Mar 2025", "Mar 2026"]


def _raw(sector="Industrials", borrowings=(50, 45, 40, 35, 30, 25)):
    pl = _stmt("profit_loss", {
        "Sales": [1000, 1150, 1320, 1520, 1750, 2000],
        "OPM %": [18, 19, 19, 20, 21, 21],
        "Other Income": [10, 12, 12, 14, 15, 16],
        "Interest": [5, 5, 4, 4, 3, 3],
        "Profit before tax": [170, 200, 235, 275, 320, 370],
        "Net Profit": [125, 148, 175, 205, 240, 278],
        "EPS in Rs": [12.5, 14.8, 17.5, 20.5, 24.0, 27.8],
        "Dividend Payout %": [20] * 6,
    }, YEARS)
    bs = _stmt("balance_sheet", {
        "Equity Capital": [10] * 6, "Reserves": [600, 720, 860, 1020, 1200, 1400],
        "Borrowings": list(borrowings), "Total Assets": [900, 1000, 1150, 1300, 1480, 1680],
    }, YEARS)
    cf = _stmt("cash_flow", {"Cash from Operating Activity": [140, 160, 190, 220, 255, 300],
                             "Free Cash Flow": [80, 90, 110, 130, 150, 180]}, YEARS)
    rt = _stmt("ratios", {"ROCE %": [22, 23, 24, 25, 26, 27], "Debtor Days": [60, 58, 57, 55, 55, 54]}, YEARS)
    qp = ["Jun 2024", "Sep 2024", "Dec 2024", "Mar 2025", "Jun 2025", "Sep 2025", "Dec 2025", "Mar 2026"]
    q = _stmt("quarterly", {"Sales": [420, 430, 440, 460, 480, 495, 505, 520],
                            "Net Profit": [57, 58, 61, 64, 66, 68, 70, 74], "OPM %": [20, 20, 21, 21, 21, 21, 22, 22]}, qp)
    return {
        "profile": {"data": {
            "company": {"name": "Acme Ltd", "nse_symbol": "ACME", "sector": sector, "industry": sector},
            "fundamentals": {"roe": 21, "roce": 27, "market_cap": 9000, "dividend_yield": 1.1},
            "price_metrics": {"price": 500, "pe_ttm": 18, "pb": 6.0, "eps_ttm": 27.8, "book_value": 141},
            "growth_metrics": {"Compounded Sales Growth": {"3 Years": "15%"}, "Compounded Profit Growth": {"3 Years": "17%"}},
            "quarterly_growth": {"latest_quarter": "Mar 2026", "sales_yoy": 13.0, "net_profit_yoy": 15.6},
        }},
        "profit_loss": pl, "balance_sheet": bs, "cash_flow": cf, "ratios": rt, "quarterly": q,
        "shareholding": {"data": [{"data": {"Promoters": {"Mar 2025": 55, "Jun 2025": 55, "Sep 2025": 55, "Dec 2025": 55, "Mar 2026": 55},
                                            "FIIs": {"Mar 2025": 10, "Mar 2026": 12}, "DIIs": {"Mar 2025": 8, "Mar 2026": 9}}}]},
        "forecasts": {"data": [{"actuals": {"price": {"202303": 350, "202403": 420, "202503": 480},
                                            "eps": {"202303": 17.5, "202403": 20.5, "202503": 24.0}},
                                "latest": {"eps_estimate": 32, "price_estimate": 600, "price_estimate_high": 700, "price_estimate_low": 500}}]},
        "pledge": {"data": {"latest_pledged_pct_of_promoter_holding": "0"}},
    }


def test_fundamentals_quality_compounder_scores_well():
    f = analyze_fundamentals(_raw())
    assert f["available"]
    assert f["score"] >= 70
    assert f["quality"]["piotroski"]["available"] and f["quality"]["piotroski"]["score"] >= 6
    assert f["financial_health"]["debt_to_equity"] == pytest.approx(25 / 1410, abs=0.01)
    assert f["valuation"]["median_pe_hist"] == pytest.approx(20.0, abs=0.1)
    assert f["valuation"]["forward_pe"] == pytest.approx(500 / 32, abs=0.1)
    assert f["valuation"]["analyst_target"]["upside_pct"] == pytest.approx(20.0)
    assert f["ownership"]["institutional_change_1y"] == pytest.approx(3.0)
    assert len(f["growth"]["quarters"]) == 8 and f["growth"]["quarters"][-1]["sales_yoy"] is not None


def test_leverage_shows_up_as_red_flag():
    f = analyze_fundamentals(_raw(borrowings=(100, 300, 600, 900, 1300, 1800)))
    assert any("Debt / Equity" in r for r in f["red_flags"])
    assert f["pillars"]["financial_health"] < analyze_fundamentals(_raw())["pillars"]["financial_health"]


def test_banks_skip_industrial_leverage_tests():
    f = analyze_fundamentals(_raw(sector="Banks", borrowings=(5000, 6000, 7000, 8000, 9000, 10000)))
    assert f["financial_health"]["is_financial"]
    labels = [c["label"] for c in f["checks"]["financial_health"]]
    assert not any("Debt / Equity" in l for l in labels)
    assert not f["quality"]["piotroski"]["available"]


def test_fundamentals_without_data():
    assert analyze_fundamentals({})["available"] is False


def test_series_and_cagr_helpers():
    raw = _raw()
    s = series(raw["profit_loss"], "Sales")
    assert [p for p, _ in s] == YEARS
    assert cagr(100, 121, 2) == pytest.approx(10.0)
    assert cagr(0, 10, 2) is None


# ── service plumbing ──

def test_split_financials_by_section():
    resp = {"data": [{"section": "quarterly", "data": {}}, {"section": "ratios", "data": {"ROCE %": {}}}]}
    out = _split_financials(resp)
    assert set(out) == {"quarterly", "ratios"}
    assert out["ratios"]["data"][0]["section"] == "ratios"


def test_quota_error_detection():
    assert TapetideBudget.is_quota_error("You've used all 50 free Tapetide MCP tool calls for today. The limit resets at midnight IST")
    assert not TapetideBudget.is_quota_error("MCP error -32602: Input validation error")


def test_service_uses_disk_cache_without_tapetide_calls(tmp_path, monkeypatch, db):
    monkeypatch.setattr(svc_mod, "_CACHE_DIR", tmp_path)
    monkeypatch.setattr(TapetideBudget, "path", tmp_path / "_quota.json")
    svc_mod._CACHE.clear()
    from datetime import datetime
    svc_mod._disk_cache_write("ACME", {"fetched_at": datetime.now().isoformat(timespec="seconds"),
                                       "tapetide_symbol": "ACME", "raw": _raw()})

    async def boom(*a, **k):
        raise AssertionError("Tapetide must not be called when the cache is fresh")

    async def prices(self, instrument, tt_symbol, bse_code=None):
        return _candles(drift=0.001), None, "test candles", None

    monkeypatch.setattr(TechnoFundaService, "_fetch_tapetide", boom)
    monkeypatch.setattr(TechnoFundaService, "_fetch_prices", prices)

    async def no_business(self, raw, ticker):  # keep tests offline
        return {"_business_fetched": True}, 0

    monkeypatch.setattr(TechnoFundaService, "_fetch_business", no_business)
    out = asyncio.run(TechnoFundaService(db).analyze("acme"))
    assert out["symbol"] == "ACME"
    assert out["sources"]["fundamentals_meta"]["source"] == "cache"
    assert out["verdict"]["score"] is not None and out["verdict"]["quadrant"]
    assert out["fundamental"]["available"] and out["technical"]["available"]
    assert "not investment advice" in out["disclaimer"]
