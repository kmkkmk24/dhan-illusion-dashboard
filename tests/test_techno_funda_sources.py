"""TechnoFunda free sources: Screener page parsing, consolidated/standalone choice, Tickertape pledge
mapping, Yahoo candles, the governance cap, P/E-from-quarters, and the service's source chain."""

import asyncio
from datetime import datetime

import numpy as np
import pandas as pd
import pytest

from backend.services import techno_funda_service as svc_mod
from backend.services import techno_funda_sources as src
from backend.services.techno_funda_fundamental import analyze_fundamentals
from backend.services.techno_funda_service import TapetideBudget, TechnoFundaService, _sources_summary


def _table(sec_id, periods, rows):
    head = "".join(f"<th>{p}</th>" for p in [""] + periods)
    body = "".join("<tr><td>" + label + "</td>" + "".join(f"<td>{v}</td>" for v in vals) + "</tr>" for label, vals in rows)
    return f'<section id="{sec_id}"><table><tr>{head}</tr>{body}</table></section>'


YEARS = ["Mar 2021", "Mar 2022", "Mar 2023", "Mar 2024", "Mar 2025", "Mar 2026", "TTM"]
QTRS = ["Jun 2024", "Sep 2024", "Dec 2024", "Mar 2025", "Jun 2025", "Sep 2025", "Dec 2025", "Mar 2026"]


def _page(lender=False, quarters=True, name="Acme Ltd"):
    sales = "Revenue +" if lender else "Sales +"
    borrow = "Borrowing" if lender else "Borrowings"
    html = f"""<html><body><h1>{name}</h1>
    <ul id="top-ratios">
      <li><span class="name">Market Cap</span><span class="value">₹ 9,000 Cr.</span></li>
      <li><span class="name">Current Price</span><span class="value">₹ 500</span></li>
      <li><span class="name">High / Low</span><span class="value">₹ 600 / 400</span></li>
      <li><span class="name">Stock P/E</span><span class="value">18.0</span></li>
      <li><span class="name">Book Value</span><span class="value">₹ 141</span></li>
      <li><span class="name">Dividend Yield</span><span class="value">1.10 %</span></li>
      <li><span class="name">ROCE</span><span class="value">27.0 %</span></li>
      <li><span class="name">ROE</span><span class="value">21.0 %</span></li>
    </ul>
    <div class="company-profile"><div class="about"><p>Makes widgets.</p></div></div>
    <a href="https://www.bseindia.com/stock-share-price/acme/ACME/500123/">BSE: 500123</a>
    <a href="https://www.nseindia.com/get-quotes/derivatives?symbol=ACME">F&amp;O</a>
    <div class="pros"><ul><li>Debt free</li></ul></div><div class="cons"><ul><li>Pricey</li></ul></div>
    <table class="ranges-table"><tr><th>Compounded Sales Growth</th></tr><tr><td>3 Years:</td><td>15%</td></tr></table>
    <table class="ranges-table"><tr><th>Compounded Profit Growth</th></tr><tr><td>3 Years:</td><td>17%</td></tr></table>
    <section id="peers"><a href="/market/IN01/">{'Financial Services' if lender else 'Industrials'}</a>
      <a href="/market/IN01/1/">x</a><a href="/market/IN01/1/2/">{'Banks' if lender else 'Machinery'}</a></section>
    """
    if quarters:
        html += _table("quarters", QTRS, [
            (sales, ["420", "430", "440", "460", "480", "495", "505", "520"]),
            ("YoY Sales growth", ["1%"] * 8),
            ("Net Profit +", ["57", "58", "61", "64", "66", "68", "70", "74"]),
            ("OPM %", ["20%", "20%", "21%", "21%", "21%", "21%", "22%", "22%"]),
            ("EPS in Rs", ["5.7", "5.8", "6.1", "6.4", "6.6", "6.8", "7.0", "7.4"]),
            ("Raw PDF", [""] * 8),
        ])
    html += _table("profit-loss", YEARS, [
        (sales, ["1,000", "1,150", "1,320", "1,520", "1,750", "2,000", "2,050"]),
        ("OPM %", ["18%", "19%", "19%", "20%", "21%", "21%", "21%"]),
        ("Other Income +", ["10", "12", "12", "14", "15", "16", "16"]),
        ("Interest", ["5", "5", "4", "4", "3", "3", "3"]),
        ("Profit before tax", ["170", "200", "235", "275", "320", "370", "380"]),
        ("Net Profit +", ["125", "148", "175", "205", "240", "278", "285"]),
        ("EPS in Rs", ["12.5", "14.8", "17.5", "20.5", "24.0", "27.8", "28.5"]),
    ])
    html += _table("balance-sheet", YEARS[:-1], [
        ("Equity Capital", ["10"] * 6), ("Reserves", ["600", "720", "860", "1,020", "1,200", "1,400"]),
        (borrow, ["50", "45", "40", "35", "30", "25"]), ("Total Assets", ["900", "1,000", "1,150", "1,300", "1,480", "1,680"]),
    ])
    html += _table("cash-flow", YEARS[:-1], [("Cash from Operating Activity +", ["140", "160", "190", "220", "255", "300"]),
                                              ("Free Cash Flow", ["80", "90", "110", "130", "150", "180"])])
    html += _table("ratios", YEARS[:-1], [("ROCE %", ["22%", "23%", "24%", "25%", "26%", "27%"])])
    shp_rows = "".join(f"<tr><td>{l}</td>" + "".join(f"<td>{v}</td>" for v in vals) + "</tr>" for l, vals in [
        ("Promoters +", ["55.00%", "55.00%", "55.00%", "55.00%", "55.00%"]),
        ("FIIs +", ["10.00%", "10.50%", "11.00%", "11.50%", "12.00%"]),
        ("DIIs +", ["8.00%", "8.20%", "8.50%", "8.80%", "9.00%"]),
        ("No. of Shareholders", ["1,000", "1,100", "1,200", "1,300", "1,400"])])
    html += ('<section id="shareholding"><div id="quarterly-shp"><table><tr><th></th>'
             + "".join(f"<th>{p}</th>" for p in ["Mar 2025", "Jun 2025", "Sep 2025", "Dec 2025", "Mar 2026"])
             + f"</tr>{shp_rows}</table></div></section></body></html>")
    return html


def test_parse_screener_page_into_engine_shape():
    p = src.parse_screener_html(_page(), "ACME")
    assert set(p) >= {"quarterly", "profit_loss", "balance_sheet", "cash_flow", "ratios", "shareholding", "profile"}
    pl = p["profit_loss"]["data"][0]["data"]
    assert pl["Sales"]["Mar 2026"] == 2000 and pl["Net Profit"]["TTM"] == 285
    assert "YoY Sales growth" not in p["quarterly"]["data"][0]["data"]
    prof = p["profile"]["data"]
    assert prof["company"]["bse_code"] == "500123" and prof["company"]["is_fno"] is True
    assert prof["company"]["sector"] == "Industrials" and prof["company"]["industry"] == "Machinery"
    assert prof["fundamentals"]["market_cap"] == 9000 and prof["price_metrics"]["eps_ttm"] == 28.5
    assert prof["fundamentals"]["high_52w"] == 600 and prof["fundamentals"]["low_52w"] == 400
    assert prof["growth_metrics"]["Compounded Sales Growth"]["3 Years"] == "15%"
    assert prof["quarterly_growth"]["sales_yoy"] == pytest.approx((520 / 460 - 1) * 100, abs=0.01)
    f = analyze_fundamentals(p)
    assert f["available"] and f["score"] >= 60
    assert f["ownership"]["promoter"] == 55.0


def test_lender_rows_are_normalised():
    p = src.parse_screener_html(_page(lender=True), "BANK")
    assert "Sales" in p["profit_loss"]["data"][0]["data"]
    assert "Borrowings" in p["balance_sheet"]["data"][0]["data"]
    assert analyze_fundamentals(p)["financial_health"]["is_financial"]


def test_falls_back_to_standalone_when_consolidated_lacks_quarters(monkeypatch):
    pages = {"/company/ACME/consolidated/": _page(quarters=False), "/company/ACME/": _page(quarters=True)}
    calls = []

    async def fake_get(self, client, path):
        calls.append(path)
        return pages.get(path)

    monkeypatch.setattr(src.ScreenerSource, "_get", fake_get)
    # Real 0.6 s politeness pause. (Never stub asyncio.sleep with a lambda calling asyncio.sleep:
    # the patched name points back at the lambda and it recurses until memory runs out.)
    out = asyncio.run(src.ScreenerSource().fetch("ACME"))
    assert calls == ["/company/ACME/consolidated/", "/company/ACME/"]
    assert out["profile"]["data"]["statement_basis"] == "standalone"


def test_consolidated_kept_when_complete(monkeypatch):
    async def fake_get(self, client, path):
        return _page()

    monkeypatch.setattr(src.ScreenerSource, "_get", fake_get)
    out = asyncio.run(src.ScreenerSource().fetch("ACME"))
    assert out["profile"]["data"]["statement_basis"] == "consolidated"


def test_tickertape_pledge_mapping():
    df = pd.DataFrame({"date": ["2026-03-31T00:00:00.000Z", "2026-06-30T00:00:00.000Z"],
                       "data_pmPctT": [56.5, 54.8], "data_pmPctP": [99.99, 99.98], "data_fiPctT": [13.9, 15.8],
                       "data_diPctT": [13.4, 10.8], "data_rhPctT": [11.2, 13.7], "data_mfPctT": [6.9, 4.6]})
    out = src._tickertape_shareholding(df)
    assert out["pledge"]["data"]["latest_pledged_pct_of_promoter_holding"] == 99.98
    assert out["shareholding"]["data"][0]["data"]["Promoters"]["Jun 2026"] == 54.8


def test_yahoo_chart_parsing():
    ts = [1735700000 + 86400 * i for i in range(5)]
    payload = {"chart": {"result": [{"timestamp": ts, "indicators": {"quote": [{
        "open": [1, 2, 3, 4, 5], "high": [2, 3, 4, 5, 6], "low": [0.5, 1, 2, 3, 4], "close": [1.5, None, 3.5, 4.5, 5.5],
        "volume": [10, 20, 30, 40, 50]}]}}]}}
    df = src.parse_yahoo_chart(payload)
    assert list(df.columns) == ["timestamp", "open", "high", "low", "close", "volume"]
    assert len(df) == 4 and df["close"].iloc[-1] == 5.5
    assert src.parse_yahoo_chart({"chart": {"result": []}}) is None


def test_heavy_pledge_caps_fundamental_score():
    p = src.parse_screener_html(_page(), "ACME")
    clean = analyze_fundamentals(p)
    p["pledge"] = {"data": {"latest_pledged_pct_of_promoter_holding": 99.0}}
    capped = analyze_fundamentals(p)
    assert clean["score"] > 50
    assert capped["score"] <= 50 and capped["governance_cap"] == 50
    assert capped["red_flags"][0].startswith("Governance:")


def test_pe_history_from_quarters_when_no_analyst_data():
    p = src.parse_screener_html(_page(), "ACME")
    days = pd.bdate_range("2024-01-01", "2026-04-30")
    prices = pd.DataFrame({"timestamp": days, "close": np.full(len(days), 500.0)})
    f = analyze_fundamentals(p, prices=prices)
    v = f["valuation"]
    assert v["median_pe_hist"] is not None and "trailing 4Q EPS" in v["median_pe_basis"]


def test_sources_summary():
    s = _sources_summary({"profit_loss": "screener", "quarterly": "screener", "pledge": "tickertape", "news": "tapetide (saved)"})
    assert s == "Screener.in (statements) · Tickertape (pledge) · Tapetide MCP (saved) (news)"


def test_service_chain_uses_free_sources_and_falls_back_to_tapetide(tmp_path, monkeypatch, db):
    monkeypatch.setattr(svc_mod, "_CACHE_DIR", tmp_path)
    monkeypatch.setattr(TapetideBudget, "path", tmp_path / "_quota.json")
    svc_mod._CACHE.clear()
    tapetide_plans = []

    async def screener_ok(self, symbol):
        return src.parse_screener_html(_page(), symbol)

    async def screener_down(self, symbol):
        raise RuntimeError("Screener rate limit (HTTP 429)")

    async def tickertape(self, symbol):
        return {"pledge": {"data": {"latest_pledged_pct_of_promoter_holding": 0.0}},
                "scorecard": [{"name": "Red flags", "tag": "Low", "type": "redFlag", "description": "No red flag found"}]}

    async def tapetide(self, symbol, plan):
        tapetide_plans.append(sorted(plan))
        if "profile" in plan:
            return ({"profile": {"data": {"company": {"name": "Acme (Tapetide)"}, "fundamentals": {"roe": 20}}}}, {}, 1, False)
        return ({"concall": {"data": {"summaries": []}}}, {}, len(plan), False)

    async def prices(self, instrument, ticker, bse_code=None):
        days = pd.bdate_range("2024-06-03", periods=300)
        close = 100 * np.exp(np.cumsum(np.full(300, 0.001)))
        return pd.DataFrame({"timestamp": days, "open": close, "high": close * 1.01, "low": close * 0.99,
                             "close": close, "volume": 1e5}), None, "test", None

    monkeypatch.setattr(src.TickertapeSource, "fetch", tickertape)
    monkeypatch.setattr(TechnoFundaService, "_fetch_tapetide", tapetide)
    monkeypatch.setattr(TechnoFundaService, "_fetch_prices", prices)

    async def no_business(self, raw, ticker):  # keep tests offline
        return {"_business_fetched": True}, 0

    monkeypatch.setattr(TechnoFundaService, "_fetch_business", no_business)

    monkeypatch.setattr(src.ScreenerSource, "fetch", screener_ok)
    out = asyncio.run(TechnoFundaService(db).analyze("ACME"))
    meta = out["sources"]["fundamentals_meta"]
    assert meta["sections"]["profit_loss"] == "screener" and meta["sections"]["pledge"] == "tickertape"
    assert tapetide_plans == [["concall", "forecasts", "news"]]          # extras only
    assert "Screener.in" in out["sources"]["fundamentals"]
    assert out["fundamental"]["tickertape_scorecard"][0]["name"] == "Red flags"

    # Screener down → Tapetide core statements are fetched as the fallback
    svc_mod._CACHE.clear()
    tapetide_plans.clear()
    monkeypatch.setattr(src.ScreenerSource, "fetch", screener_down)
    out2 = asyncio.run(TechnoFundaService(db).analyze("OTHER"))
    assert ["financials", "pledge", "profile", "shareholding"] in tapetide_plans
    assert "screener" in out2["sources"]["fundamentals_meta"]["errors"]
