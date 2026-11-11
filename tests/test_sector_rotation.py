"""Relative Rotation Graph maths, persistence, analyzer slice and API."""

import asyncio
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from backend.services import sector_rotation as sr
from conftest import make_app


def frame(closes, start="2025-12-01"):
    idx = pd.bdate_range(start, periods=len(closes))
    c = np.asarray(closes, dtype=float)
    return pd.DataFrame({"timestamp": idx, "open": c, "high": c, "low": c, "close": c, "volume": 0})


N = 230
bench = 100 * np.cumprod(np.full(N, 1.0005))           # steady market
t = np.arange(N)


def rel(path):
    """Sector closes = benchmark * relative path."""
    return bench * path


@pytest.mark.parametrize("ratio,mom,expected", [
    (101, 101, "Leading"), (101, 99, "Weakening"), (99, 99, "Lagging"), (99, 101, "Improving"),
])
def test_quadrants(ratio, mom, expected):
    assert sr.quadrant(ratio, mom) == expected


def test_accelerating_outperformer_is_leading():
    sector = rel(np.exp(0.00002 * t ** 2))             # relative strength rising faster and faster
    trail = sr.compute_rrg(sr._close_series(frame(sector)), sr._close_series(frame(bench)), window=20, tail=10)
    assert len(trail) == 10
    assert sr.quadrant(trail[-1]["ratio"], trail[-1]["momentum"]) == "Leading"


def test_accelerating_underperformer_is_lagging():
    sector = rel(np.exp(-0.00002 * t ** 2))
    trail = sr.compute_rrg(sr._close_series(frame(sector)), sr._close_series(frame(bench)), window=20, tail=10)
    assert sr.quadrant(trail[-1]["ratio"], trail[-1]["momentum"]) == "Lagging"


def _rollover(bars_down):
    up = N - bars_down
    path = np.concatenate([np.exp(0.004 * t[:up]), np.exp(0.004 * (up - 1)) * np.exp(-0.002 * (t[up:] - (up - 1)))])
    trail = sr.compute_rrg(sr._close_series(frame(rel(path))), sr._close_series(frame(bench)), window=20, tail=10)
    return sr.quadrant(trail[-1]["ratio"], trail[-1]["momentum"])


def test_leader_rotates_clockwise_through_weakening_into_lagging():
    # a relative uptrend that just topped is Weakening; a sustained decline ends Lagging
    assert _rollover(4) == "Weakening"
    assert _rollover(40) == "Lagging"


def test_too_little_history_returns_empty():
    assert sr.compute_rrg(sr._close_series(frame(bench[:30])), sr._close_series(frame(bench[:30])), window=20, tail=10) == []


def test_heading_and_returns():
    h = sr.heading([{"ratio": 100, "momentum": 100}, {"ratio": 101, "momentum": 101}])
    assert h["angle"] == 45.0 and h["speed"] == pytest.approx(1.414, abs=1e-3)
    r = sr.returns(pd.Series([100.0] * 70 + [110.0]))
    assert r["1D"] == 10.0 and r["3M"] == 10.0


def test_build_rotation_payload_and_roundtrip(tmp_path):
    frames = {
        "Nifty IT": frame(rel(np.exp(0.00002 * t ** 2))),
        "Nifty Metal": frame(rel(np.exp(-0.00002 * t ** 2))),
        "Broken": pd.DataFrame({"nope": [1]}),
    }
    payload = sr.build_rotation(frames, frame(bench))
    assert payload["available"] is True
    daily = payload["timeframes"]["daily"]
    names = [s["sector_name"] for s in daily["sectors"]]
    assert names == ["Nifty IT", "Nifty Metal"]            # sorted by flow, broken sector skipped
    assert daily["quadrants"]["Leading"] == 1 and daily["quadrants"]["Lagging"] == 1
    assert payload["timeframes"]["weekly"]["sectors"], "weekly view should have enough history"
    assert {p["sector_name"] for p in payload["performance"]} == {"Nifty IT", "Nifty Metal"}

    path = tmp_path / "rot.json"
    sr.save_rotation(payload, path)
    assert sr.load_rotation(path) == payload


def test_load_rotation_missing_or_corrupt(tmp_path):
    assert sr.load_rotation(tmp_path / "none.json")["available"] is False
    bad = tmp_path / "bad.json"
    bad.write_text("{not json")
    assert sr.load_rotation(bad)["available"] is False


def test_analyzer_scores_use_180_days_and_rotation_is_saved(monkeypatch, db, tmp_path):
    from backend.services import sector_analyzer as sa

    today = date.today()
    days = pd.bdate_range(today - timedelta(days=320), today)
    seen = []

    async def fake_fetch(self, security_id, from_date, to_date):
        seen.append(from_date)
        k = np.arange(len(days))
        c = np.linspace(100, 130, len(days)) * (1 + 0.02 * np.sin(k / 9 + int(security_id)))  # distinct per index
        return pd.DataFrame({"timestamp": days, "open": c, "high": c, "low": c, "close": c, "volume": 0})

    async def no_intraday(self, security_id):
        return None

    class NoDhan:
        async def close(self):
            pass

    monkeypatch.setattr(sa.SectorAnalyzer, "_fetch_index_data", fake_fetch)
    monkeypatch.setattr(sa.SectorAnalyzer, "_fetch_intraday_15m_data", no_intraday)
    monkeypatch.setattr(sa, "DhanClient", NoDhan)
    real_sleep = asyncio.sleep  # sa.asyncio is the global module: keep the original to avoid recursion
    monkeypatch.setattr(sa.asyncio, "sleep", lambda *_: real_sleep(0))
    rot_path = tmp_path / "rotation.json"
    monkeypatch.setattr(sr, "_cache_path", lambda: rot_path)

    captured = {}
    real_pa = sa.SectorAnalyzer._compute_price_action

    def spy_pa(self, df):
        captured.setdefault("rows", len(df))
        captured.setdefault("first", pd.to_datetime(df["timestamp"]).min().date())
        return real_pa(self, df)

    monkeypatch.setattr(sa.SectorAnalyzer, "_compute_price_action", spy_pa)

    results = asyncio.run(sa.SectorAnalyzer(db).analyze_sectors())
    assert results
    assert all(d == today - timedelta(days=sa.ROTATION_HISTORY_DAYS) for d in seen)
    assert captured["first"] >= today - timedelta(days=180)
    assert sr.load_rotation(rot_path)["available"] is True


def test_rotation_endpoint(SessionLocal, monkeypatch, tmp_path):
    from backend.api import settings as settings_api

    monkeypatch.setattr(sr, "_cache_path", lambda: tmp_path / "rotation.json")
    http = make_app(SessionLocal, settings_api.router)
    assert http.get("/api/settings/sectors/rotation").json()["available"] is False
    sr.save_rotation({"available": True, "timeframes": {}})
    assert http.get("/api/settings/sectors/rotation").json()["available"] is True


# ── Today's candle from intraday + trend after a restart ──

def test_today_candle_is_built_from_intraday_bars():
    import pandas as pd
    from backend.services.sector_analyzer import with_intraday_today

    daily = pd.DataFrame({"timestamp": pd.to_datetime(["2026-11-06", "2026-11-09"]),
                          "open": [1.0, 2.0], "high": [1.5, 2.5], "low": [0.5, 1.5], "close": [1.2, 2.2], "volume": [0, 0]})
    bars = pd.DataFrame({"timestamp": pd.to_datetime(["2026-11-09 15:15", "2026-11-11 09:15", "2026-11-11 09:30", "2026-11-11 15:15"]),
                         "open": [9, 10, 11, 12], "high": [9, 13, 14, 12.5], "low": [9, 9.5, 10, 11], "close": [9, 11, 12, 12.2], "volume": [0, 0, 0, 0]})
    out = with_intraday_today(daily, bars)
    assert len(out) == 3                                  # 9 Nov already had a daily candle
    last = out.iloc[-1]
    assert str(last.timestamp.date()) == "2026-11-11"
    assert (last.open, last.high, last.low, last.close) == (10, 14, 9.5, 12.2)
    assert with_intraday_today(daily, None) is daily      # no intraday data -> unchanged


def test_sectors_all_has_trend_without_cache(SessionLocal):
    from datetime import date
    import backend.models.tables as T
    from backend.api import settings as settings_api
    from conftest import make_app

    settings_api.set_sector_analysis_cache([], as_of=date(2000, 1, 1))     # simulate a restart
    s = SessionLocal()
    s.add(T.SectorScore(sector_name="Nifty IT", date=date.today(), relative_strength=0.8, daily_rs=0.8,
                        weekly_rs=0.8, monthly_rs=0.8, price_action_score=1, combined_score=0.9,
                        is_above_20ema=True, is_above_50ema=True, is_making_higher_highs=True,
                        is_making_higher_lows=True, is_ema_aligned=True))
    s.add(T.SectorScore(sector_name="Nifty Media", date=date.today(), relative_strength=0.1, daily_rs=0.1,
                        weekly_rs=0.1, monthly_rs=0.1, price_action_score=0, combined_score=0.1,
                        is_above_20ema=False, is_above_50ema=False, is_making_higher_highs=False,
                        is_making_higher_lows=False, is_ema_aligned=False))
    s.commit(); s.close()
    rows = make_app(SessionLocal, settings_api.router).get("/api/settings/sectors/all").json()
    assert {r["sector_name"]: r["trend"] for r in rows} == {"Nifty IT": "Strong", "Nifty Media": "Bearish"}
