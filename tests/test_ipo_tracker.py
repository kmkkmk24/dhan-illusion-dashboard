"""IPO tracker: NSE list parsing, Dhan matching, ATH maths, incremental refresh and the API."""

import asyncio
from datetime import date

import pandas as pd
import pytest

import backend.models.tables as T
from backend.services import ipo_tracker as it
from conftest import make_app

TODAY = date(2026, 11, 11)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(it, "_cache_path", lambda: tmp_path / "ipo_tracker.json")
    monkeypatch.setattr(it, "_lock", asyncio.Lock())
    it.invalidate()
    yield
    it.invalidate()


def _nse(symbol, listed, price="100", kind="Equity", name=None):
    return {"symbol": symbol, "companyName": name or f"{symbol} Limited", "listingDate": listed,
            "issuePrice": price, "securityType": kind}


# ── NSE list ──

def test_parse_keeps_main_board_within_five_years():
    rows = [
        _nse("NEWCO", "10-NOV-2026", "Rs.88 to Rs.94"),
        _nse("SMECO", "09-NOV-2026", kind="SME"),
        _nse("IDEAFPO", "25-APR-2024", name="Vodafone Idea Limited - FPO"),
        {**_nse("OLAPP", "06-NOV-2026", "11"), "ipoEndDate": "06-AUG-2024"},   # partly-paid rights
        {**_nse("ADANIENTPP", "31-JAN-2023"), "ipoEndDate": "-"},
        _nse("REITX", "01-JAN-2025", kind="REIT"),
        _nse("OLDCO", "10-NOV-2021"),            # one day before the 5-year cutoff
        _nse("EDGECO", "11-NOV-2021", "1,960"),   # exactly on the cutoff
        _nse("FUTURE", "12-NOV-2026"),            # not listed yet
        _nse("", "01-JAN-2024"),
    ]
    out = it.parse_past_issues(rows, TODAY)
    assert [r["symbol"] for r in out] == ["NEWCO", "EDGECO"]
    assert out[0]["issue_price"] == 94.0 and out[1]["issue_price"] == 1960.0
    assert out[0]["listing_date"] == "2026-11-10"


def test_start_is_fixed_so_2021_stays_and_2027_is_added():
    assert it.cutoff_date(date(2028, 2, 29)) == date(2021, 11, 11)
    rows = [_nse("NEW27", "15-JAN-2027"), _nse("PAYTM", "18-NOV-2021"), _nse("OLD", "10-NOV-2021")]
    out = it.parse_past_issues(rows, date(2027, 3, 1))
    assert [r["symbol"] for r in out] == ["NEW27", "PAYTM"]


def test_nse_fetch_is_split_into_yearly_windows():
    import httpx

    seen = []

    def handler(request):
        if "public-past-issues" not in request.url.path:
            return httpx.Response(200, text="ok")
        seen.append((request.url.params["from_date"], request.url.params["to_date"]))
        if len(seen) == 1:
            return httpx.Response(200, json=[_nse(f"S{i}", "01-DEC-2021") for i in range(25)])
        return httpx.Response(200, json=[_nse("NEW27", "15-JAN-2027")])

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    out = asyncio.run(it.fetch_ipo_list(client, today=date(2027, 3, 1)))
    assert len(seen) == 6 and seen[0][0] == "14-07-2021" and seen[-1][1] == "01-03-2027"
    assert {"NEW27", "S0"} <= {r["symbol"] for r in out}


def test_refresh_keeps_stocks_nse_stops_returning(db):
    _seed(db)
    asyncio.run(it.refresh(db, FakeDhan(), ipo_fetcher=_fetcher([_nse("AAA", "02-NOV-2026"), _nse("BBB", "03-NOV-2026")]),
                           today=date(2026, 11, 6)))
    # A year later NSE only returns a new 2027 listing; AAA and BBB stay tracked.
    s = asyncio.run(it.refresh(db, FakeDhan(), ipo_fetcher=_fetcher([_nse("NEW27", "15-JAN-2027")]),
                               today=date(2027, 11, 8)))
    assert s["ok"] and {r["symbol"] for r in it.load()["ipos"]} == {"AAA", "BBB", "NEW27"}


# ── ATH maths ──

def _candles(rows):
    return pd.DataFrame([{"timestamp": pd.Timestamp(d), "open": o, "high": h, "low": l, "close": c}
                         for d, o, h, l, c in rows])


def test_roll_forward_and_bands():
    rec = {"issue_price": 100.0}
    it.roll_forward(rec, _candles([("2026-01-05", 120, 150, 110, 140), ("2026-01-06", 140, 145, 120, 125)]))
    assert rec["listing_open"] == 120 and rec["ath"] == 150 and rec["ath_date"] == "2026-01-05"
    assert rec["close"] == 125 and rec["last_date"] == "2026-01-06"
    # Old candles are ignored; a new high moves the ATH.
    it.roll_forward(rec, _candles([("2026-01-06", 0, 999, 0, 0), ("2026-01-07", 125, 160, 124, 158)]))
    assert rec["ath"] == 160 and rec["close"] == 158 and rec["listing_open"] == 120
    it.derive(rec)
    assert rec["band"] == "at_ath" and rec["from_ath_pct"] == -1.25
    assert rec["since_issue_pct"] == 58.0 and rec["listing_gain_pct"] == 20.0
    assert it.band(85, 100) == "near" and it.band(84.9, 100) == "below" and it.band(None, 100) is None


# ── Matching ──

def test_match_by_ticker_then_unambiguous_name(db):
    db.add_all([
        T.Instrument(security_id="1", exchange="NSE", segment="E", symbol="LENSKART SOLUTIONS LTD",
                     trading_symbol="LENSKART", display_name="Lenskart Solutions"),
        T.Instrument(security_id="2", exchange="NSE", segment="E", symbol="ETERNAL LIMITED",
                     trading_symbol="ETERNAL", display_name="Zomato Foods"),
        T.Instrument(security_id="3", exchange="NSE", segment="E", symbol="ALPHA BETA LTD", trading_symbol="AB1", display_name="Alpha Beta"),
        T.Instrument(security_id="4", exchange="NSE", segment="E", symbol="ALPHA BETA LTD", trading_symbol="AB2", display_name="Alpha Beta"),
    ])
    db.commit()
    ipos = [{"symbol": "LENSKART", "company": "x"},
            {"symbol": "ZOMATO", "company": "Zomato Foods Limited"},     # renamed ticker -> by name
            {"symbol": "ABX", "company": "Alpha Beta Limited"}]          # two candidates -> no match
    m = it.match_instruments(db, ipos)
    assert m["LENSKART"].security_id == "1" and m["ZOMATO"].security_id == "2" and "ABX" not in m


# ── Refresh ──

class FakeDhan:
    def __init__(self):
        self.calls = []

    async def get_historical_daily_data(self, security_id, exchange_segment, instrument, from_date, to_date):
        self.calls.append((security_id, from_date, to_date))
        days = pd.bdate_range(from_date, to_date)
        base = 100 if security_id == "1" else 50
        return pd.DataFrame({"timestamp": days, "open": base, "high": [base + i for i in range(len(days))],
                             "low": base - 1, "close": [base + i - 0.5 for i in range(len(days))]})

    async def close(self):
        pass


def _seed(db):
    db.add_all([
        T.Instrument(security_id="1", exchange="NSE", segment="E", symbol="AAA LTD", trading_symbol="AAA",
                     is_fno=True, lot_size=500),
        T.Instrument(security_id="2", exchange="NSE", segment="E", symbol="BBB LTD", trading_symbol="BBB"),
    ])
    db.commit()


def _fetcher(rows):
    async def fetch(today=None):
        return it.parse_past_issues(rows, today)
    return fetch


def test_refresh_full_then_incremental(db):
    _seed(db)
    rows = [_nse("AAA", "02-NOV-2026", "90"), _nse("BBB", "03-NOV-2026"), _nse("GONE", "04-NOV-2026")]
    dhan = FakeDhan()
    s = asyncio.run(it.refresh(db, dhan, ipo_fetcher=_fetcher(rows), today=date(2026, 11, 6)))
    assert s["ok"] and s["ipos"] == 3 and s["on_dhan"] == 2
    assert ("1", date(2026, 11, 2), date(2026, 11, 6)) in dhan.calls          # from the listing day
    data = it.load()
    aaa = next(r for r in data["ipos"] if r["symbol"] == "AAA")
    assert aaa["is_fno"] and aaa["lot_size"] == 500 and aaa["ath"] == 104 and aaa["band"] == "at_ath"
    gone = next(r for r in data["ipos"] if r["symbol"] == "GONE")
    assert gone["in_dhan"] is False and gone["band"] is None

    # Next day: only the new candle is fetched, and the list download failing keeps the old list.
    async def broken(today=None):
        raise RuntimeError("NSE down")
    dhan2 = FakeDhan()
    s2 = asyncio.run(it.refresh(db, dhan2, ipo_fetcher=broken, today=date(2026, 11, 9)))
    assert s2["ok"] and s2["list_error"] and s2["ipos"] == 3
    assert ("1", date(2026, 11, 7), date(2026, 11, 9)) in dhan2.calls
    assert all(r["last_date"] == "2026-11-09" for r in it.load()["ipos"] if r["in_dhan"])


def test_refresh_without_any_list_fails_cleanly(db):
    async def broken(today=None):
        raise RuntimeError("NSE down")
    s = asyncio.run(it.refresh(db, FakeDhan(), ipo_fetcher=broken, today=TODAY))
    assert s["ok"] is False and "NSE" in s["detail"] and it.status["error"] and not it.status["running"]


# ── API ──

def test_list_endpoint(SessionLocal, db):
    from backend.api import ipos

    _seed(db)
    asyncio.run(it.refresh(db, FakeDhan(), ipo_fetcher=_fetcher([_nse("AAA", "02-NOV-2026")]), today=date(2026, 11, 6)))
    data = make_app(SessionLocal, ipos.router).get("/api/ipos").json()
    assert data["available"] and data["ipos"][0]["symbol"] == "AAA"
    assert data["thresholds"] == {"at_ath": 0.98, "near_ath": 0.85}
