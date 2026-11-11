"""Dhan /charts/historical: toDate is non-inclusive, so the client must ask for the next day."""

import asyncio
from datetime import date, datetime, timedelta

import pandas as pd
import pytest

import backend.services.dhan_client as dc


class FakeResponse:
    def __init__(self, payload):
        self.status_code = 200
        self.text = ""
        self.headers = {}
        self._payload = payload

    def json(self):
        return self._payload


class FakeHistoryApi:
    """Behaves like Dhan: returns weekday candles in [fromDate, toDate)."""

    def __init__(self):
        self.requests = []

    async def post(self, path, json):
        self.requests.append(json)
        start = date.fromisoformat(json["fromDate"])
        end = date.fromisoformat(json["toDate"])  # exclusive, as documented
        days = [d for d in pd.date_range(start, end - timedelta(days=1)) if d.weekday() < 5]
        ts = [int(datetime(d.year, d.month, d.day, tzinfo=dc._IST).timestamp()) for d in days]
        n = len(ts)
        return FakeResponse({"timestamp": ts, "open": [1.0] * n, "high": [1.0] * n,
                             "low": [1.0] * n, "close": [1.0] * n, "volume": [0] * n})


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(dc, "get_dhan_credentials",
                        lambda: {"client_id": "1", "api_key": "k", "api_secret": "s", "access_token": "t"})
    c = dc.DhanClient(hist_min_interval=0, hist_chunk_pause=0)
    api = FakeHistoryApi()

    async def get_client():
        return api

    monkeypatch.setattr(c, "_get_client", get_client)
    return c, api


def test_single_request_includes_end_date(client):
    c, api = client
    end = date(2026, 11, 11)  # a Wednesday
    df = asyncio.run(c.get_historical_daily_data("13", "IDX_I", "INDEX", end - timedelta(days=30), end))
    assert api.requests[0]["toDate"] == "2026-11-12"          # next day, because Dhan's toDate is exclusive
    assert df["timestamp"].max().date() == end                  # the end date's candle is present


def test_chunked_request_has_no_gaps(client):
    c, api = client
    start, end = date(2024, 1, 1), date(2026, 11, 11)          # > 330 days -> several chunks
    df = asyncio.run(c.get_historical_daily_data("13", "IDX_I", "INDEX", start, end))
    assert len(api.requests) > 1
    # Each chunk's exclusive toDate must equal the previous (later) chunk's fromDate: no day skipped.
    for later, earlier in zip(api.requests, api.requests[1:]):
        assert earlier["toDate"] == later["fromDate"]
    got = set(df["timestamp"].dt.date)
    expected = {d.date() for d in pd.date_range(start, end) if d.weekday() < 5}
    assert got == expected
