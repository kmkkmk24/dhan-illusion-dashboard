"""Official sector constituents, ISIN matching, sector stock endpoint, and F&O lot sizes on refresh."""

import asyncio
from datetime import date, timedelta

import httpx
import pandas as pd
import pytest

import backend.models.tables as T
from backend.services import index_constituents as ic
from backend.services import sector_mapping as sm
from conftest import make_app


@pytest.fixture(autouse=True)
def isolated_constituents(tmp_path, monkeypatch):
    monkeypatch.setattr(ic, "_cache_path", lambda: tmp_path / "index_constituents.json")
    ic.invalidate()
    sm.reload()
    yield
    ic.invalidate()
    sm.reload()


# ── Snapshot & lookups ──

def test_snapshot_covers_all_tracked_sectors():
    data = ic.load()
    assert data["source"] == "snapshot"
    assert set(data["sectors"]) == set(ic.SECTOR_SOURCES)
    assert sum(len(v) for v in data["sectors"].values()) == 730
    assert all(r["isin"] and r["symbol"] for rows in data["sectors"].values() for r in rows)


def test_every_tracked_index_has_a_dhan_security_id():
    from backend.services.sector_analyzer import SECTOR_INDICES

    assert list(SECTOR_INDICES) == list(ic.SECTOR_SOURCES)


def test_thematic_indices_never_replace_a_stocks_sectoral_primary():
    names = list(ic.SECTOR_SOURCES)
    sectoral = set(names[:names.index("Nifty Realty") + 1])
    assert "Nifty India Defence" not in sectoral and len(sectoral) == 18
    for symbol, secs in sm.STOCK_TO_SECTORS.items():
        if sectoral & set(secs):
            assert secs[0] in sectoral, symbol
    assert sm.get_sectors_for_stock("TCS")[0] == "Nifty IT"
    assert "Nifty India Digital" in sm.get_sectors_for_stock("TCS")


def test_parse_accepts_company_header_variant():
    text = "Company,Industry,Symbol,Series,ISIN Code\n" + "\n".join(
        f"Co {i},Realty,S{i},EQ,INE000B0{i:04d}" for i in range(6))
    assert ic.parse_csv(text)[0]["company"] == "Co 0"


def test_known_corrections_are_in_the_official_lists():
    assert "APOLLOHOSP" not in sm.get_stocks_in_sector("Nifty Pharma")
    assert "LT" in sm.get_stocks_in_sector("Nifty Infra")
    assert "PVRINOX" in sm.get_stocks_in_sector("Nifty Media")
    assert "TMPV" in sm.get_stocks_in_sector("Nifty Auto")
    assert {"GROWW", "ICICIAMC"} <= set(sm.get_stocks_in_sector("Nifty Capital Markets"))


def test_lookup_by_symbol_isin_and_instrument():
    isin = next(r["isin"] for r in sm.get_constituents("Nifty IT") if r["symbol"] == "TCS")
    assert "Nifty IT" in sm.get_sectors_for_stock("tcs")
    assert "Nifty IT" in sm.get_sectors_for_stock(isin)
    # A renamed ticker still matches through its ISIN.
    renamed = T.Instrument(security_id="1", exchange="NSE", segment="E", symbol="X", trading_symbol="OLDTCS", isin=isin)
    assert sm.sectors_for_instrument(renamed) == sm.get_sectors_for_stock("TCS")


# ── Live refresh ──

GOOD_CSV = "Company Name,Industry,Symbol,Series,ISIN Code\n" + "\n".join(
    f"Co {i} Ltd.,Information Technology,SYM{i},EQ,INE000A0{i:04d}" for i in range(12))


def _transport(fail_file: str):
    def handler(request: httpx.Request) -> httpx.Response:
        if fail_file in request.url.path:
            return httpx.Response(503, text="down")
        return httpx.Response(200, text="﻿" + GOOD_CSV)
    return httpx.MockTransport(handler)


def test_refresh_updates_lists_and_keeps_previous_on_failure():
    before_media = sm.get_stocks_in_sector("Nifty Media")
    client = httpx.AsyncClient(transport=_transport("ind_niftymedialist"))
    summary = asyncio.run(ic.refresh_constituents(client))
    total = len(ic.SECTOR_SOURCES)
    assert summary["updated_sectors"] == total - 1 and summary["failed_sectors"] == ["Nifty Media"]
    assert summary["total_sectors"] == total
    assert ic.load()["source"] == "niftyindices.com"
    # module-level dicts were updated in place (importers keep a live reference)
    assert sm.SECTOR_CONSTITUENTS["Nifty IT"][:2] == ["SYM0", "SYM1"]
    assert sm.get_stocks_in_sector("Nifty Media") == before_media      # failed sector kept
    # cache survives a restart (reload from disk)
    ic.invalidate(); sm.reload()
    assert sm.get_stocks_in_sector("Nifty IT")[0] == "SYM0"


@pytest.mark.parametrize("bad", ["", "a,b\n1,2", "Company Name,Industry,Symbol,Series,ISIN Code\nX,Y,Z,EQ,INE1"])
def test_parse_rejects_malformed_csv(bad):
    with pytest.raises(ValueError):
        ic.parse_csv(bad)


# ── Endpoint: all constituents, flagged when not on Dhan ──

def test_sector_stocks_endpoint_lists_every_constituent(SessionLocal):
    from backend.api import settings as settings_api

    rows = sm.get_constituents("Nifty Capital Markets")
    s = SessionLocal()
    # Two on Dhan: one F&O (matched by ISIN even with an odd ticker), one cash-only by symbol.
    s.add(T.Instrument(security_id="324", exchange="NSE", segment="E", symbol="ANGEL ONE LIMITED",
                       trading_symbol="ANGEL-OLD", isin=next(r["isin"] for r in rows if r["symbol"] == "ANGELONE"),
                       is_fno=True, lot_size=2500, display_name="Angel One"))
    s.add(T.Instrument(security_id="527", exchange="NSE", segment="E", symbol="UTI ASSET MNGMT CO LTD",
                       trading_symbol="UTIAMC", isin=None, is_fno=False, lot_size=1, display_name="UTI AMC"))
    s.commit(); s.close()

    data = make_app(SessionLocal, settings_api.router).get("/api/settings/sectors/Nifty Capital Markets/stocks").json()
    assert data["total"] == len(rows) == 17 and data["fno_count"] == 1
    by = {x["symbol"]: x for x in data["stocks"]}
    assert by["ANGELONE"]["is_fno"] and by["ANGELONE"]["lot_size"] == 2500 and by["ANGELONE"]["in_dhan"]
    assert by["UTIAMC"]["in_dhan"] and not by["UTIAMC"]["is_fno"] and by["UTIAMC"]["lot_size"] is None
    assert by["GROWW"]["in_dhan"] is False and by["GROWW"]["display_name"]       # kept, flagged
    assert data["stocks"][0]["symbol"] == "ANGELONE"                             # F&O sorted first


# ── Instrument refresh: lot sizes on the very first refresh ──

def test_first_refresh_sets_fno_lots_and_tickers(db, monkeypatch):
    import backend.services.instrument_manager as im

    soon = (date.today() + timedelta(days=10)).isoformat()
    later = (date.today() + timedelta(days=40)).isoformat()
    past = (date.today() - timedelta(days=5)).isoformat()
    rows = [
        # cash rows
        dict(EXCH_ID="NSE", SEGMENT="E", INSTRUMENT="EQUITY", SECURITY_ID=1333, ISIN="INE040A01034",
             UNDERLYING_SECURITY_ID=None, UNDERLYING_SYMBOL="HDFCBANK", SYMBOL_NAME="HDFC BANK LTD",
             DISPLAY_NAME="HDFC Bank", INSTRUMENT_TYPE="ES", LOT_SIZE=1, SM_EXPIRY_DATE=None),
        dict(EXCH_ID="NSE", SEGMENT="E", INSTRUMENT="EQUITY", SECURITY_ID=527, ISIN="INE094J01016",
             UNDERLYING_SECURITY_ID=None, UNDERLYING_SYMBOL="UTIAMC", SYMBOL_NAME="UTI ASSET MNGMT CO LTD",
             DISPLAY_NAME="UTI AMC", INSTRUMENT_TYPE="ES", LOT_SIZE=1, SM_EXPIRY_DATE=None),
        # HDFCBANK futures: expired, nearest live (650), later (750)
        *[dict(EXCH_ID="NSE", SEGMENT="D", INSTRUMENT="FUTSTK", SECURITY_ID=90000 + i, ISIN=None,
               UNDERLYING_SECURITY_ID=1333, UNDERLYING_SYMBOL="HDFCBANK", SYMBOL_NAME=f"HDFCBANK-FUT{i}",
               DISPLAY_NAME="HDFCBANK FUT", INSTRUMENT_TYPE="FUT", LOT_SIZE=lot, SM_EXPIRY_DATE=exp)
          for i, (lot, exp) in enumerate([(550, past), (750, later), (650, soon)])],
    ]
    df = pd.DataFrame(rows)

    async def fake_download():
        return df

    monkeypatch.setattr(im, "download_scrip_master", fake_download)
    asyncio.run(im.refresh_instruments(db))       # empty DB: everything is new
    hdfc = db.query(T.Instrument).filter_by(security_id="1333").one()
    uti = db.query(T.Instrument).filter_by(security_id="527").one()
    assert hdfc.is_fno and hdfc.lot_size == 650    # nearest live expiry, set on the first refresh
    assert not uti.is_fno and uti.lot_size == 1
    assert uti.trading_symbol == "UTIAMC"          # NSE ticker stored for cash-only stocks too
