"""Backup restore safety, NSE calendar (IST + holidays), candle timestamps."""

import sqlite3
from datetime import date, datetime
from unittest.mock import MagicMock
from zoneinfo import ZoneInfo

import pytest

import backend.services.backup_manager as bm
import backend.services.dhan_client as dc
import backend.services.market_calendar as mc
from backend.api import settings as settings_api
from conftest import make_app

IST = ZoneInfo("Asia/Kolkata")


def make_db(path, marker):
    c = sqlite3.connect(path)
    c.execute("create table trades (id integer primary key, note text)")
    c.execute("insert into trades(note) values (?)", (marker,))
    c.commit()
    c.close()


def note(path):
    c = sqlite3.connect(path)
    try:
        return c.execute("select note from trades").fetchone()[0]
    finally:
        c.close()


@pytest.fixture
def backups(tmp_path, monkeypatch):
    bdir = tmp_path / "backups"
    bdir.mkdir()
    live = tmp_path / "live.db"
    make_db(live, "LIVE")
    make_db(bdir / "trades_good.db", "BACKUP")
    (bdir / "trades_fake.db").write_bytes(b"not a database")
    c = sqlite3.connect(bdir / "trades_notrades.db")
    c.execute("create table x(a)")
    c.commit()
    c.close()
    make_db(tmp_path / "trades_outside.db", "OUTSIDE")
    engine = MagicMock()
    monkeypatch.setattr(bm, "get_backup_path", lambda: bdir)
    monkeypatch.setattr(bm, "get_db_path", lambda: live)
    monkeypatch.setattr("backend.models.database.get_engine", lambda: engine)
    return bdir, live, engine, tmp_path


@pytest.mark.parametrize("name", ["../trades_outside.db", "..\\trades_outside.db", "trades_good.db/../../x.db",
                                  "foo.db", "", "trades_.db", "trades_missing.db"])
def test_restore_rejects_bad_names(backups, name):
    _, live, _, tmp = backups
    with pytest.raises((ValueError, FileNotFoundError)):
        bm.restore_backup(name)
    with pytest.raises((ValueError, FileNotFoundError)):
        bm.restore_backup(str(tmp / "trades_outside.db"))
    assert note(live) == "LIVE"


@pytest.mark.parametrize("name", ["trades_fake.db", "trades_notrades.db"])
def test_restore_rejects_invalid_databases(backups, name):
    _, live, _, _ = backups
    with pytest.raises(ValueError):
        bm.restore_backup(name)
    assert note(live) == "LIVE"


def test_valid_restore_snapshots_then_replaces(backups):
    bdir, live, engine, _ = backups
    bm.restore_backup("trades_good.db")
    assert note(live) == "BACKUP"
    pre = list(bdir.glob("trades_pre_restore_*.db"))
    assert pre and note(pre[0]) == "LIVE"
    assert engine.dispose.called


def test_default_backup_dir(monkeypatch):
    monkeypatch.setattr(bm, "get_config", lambda: {"backup": {"path": ""}})
    assert bm.get_backup_path().as_posix().endswith("data/backups")


def test_backup_api_status_codes(backups, SessionLocal):
    _, _, _, tmp = backups
    http = make_app(SessionLocal, settings_api.router)
    assert http.post("/api/settings/backup/restore", params={"filename": "../x.db"}).status_code == 400
    assert http.post("/api/settings/backup/restore", params={"filename": "trades_nope.db"}).status_code == 404
    r = http.post("/api/settings/backup/now", params={"custom_path": str(tmp / "evil")})
    assert r.status_code == 200 and not (tmp / "evil").exists()


# ── calendar ──

@pytest.fixture
def cal(monkeypatch):
    monkeypatch.setattr(mc, "_config_holidays", lambda: {date(2027, 1, 26)})


@pytest.mark.parametrize("d,expected", [
    (date(2026, 11, 9), True),     # traded (the old list wrongly had it closed)
    (date(2026, 11, 10), False),   # Diwali Balipratipada (built-in)
    (date(2026, 11, 8), True),     # Sunday Muhurat session
    (date(2026, 11, 24), False),   # Guru Nanak Jayanti
    (date(2026, 11, 30), True),    # ordinary Monday (old list wrongly had it closed)
    (date(2026, 11, 11), True),    # Wednesday
    (date(2026, 11, 14), False),   # Saturday
    (date(2027, 1, 26), False),    # from config
    (date(2026, 12, 25), False),   # built-in kept alongside config
])
def test_trading_days(cal, d, expected):
    assert mc.is_trading_day(d) is expected


@pytest.mark.parametrize("at,expected", [
    (datetime(2026, 11, 11, 10, 0, tzinfo=IST), True),
    (datetime(2026, 11, 11, 9, 14, tzinfo=IST), False),
    (datetime(2026, 11, 11, 15, 31, tzinfo=IST), False),
    (datetime(2026, 11, 10, 10, 0, tzinfo=IST), False),
    (datetime(2026, 11, 8, 10, 0, tzinfo=IST), False),    # Muhurat day, before its session
    (datetime(2026, 11, 8, 14, 30, tzinfo=IST), True),    # inside the Muhurat session
    (datetime(2026, 11, 11, 4, 30, tzinfo=ZoneInfo("UTC")), True),  # 10:00 IST
])
def test_market_open(cal, at, expected):
    assert mc.is_market_open(at) is expected


def test_next_trading_day_skips_holidays_and_weekend(cal):
    assert mc.next_trading_day(date(2026, 11, 9)) == date(2026, 11, 11)   # skips the 10th
    assert mc.next_trading_day(date(2026, 11, 6)) == date(2026, 11, 8)    # Muhurat session counts


def test_invalid_config_holiday_ignored(monkeypatch):
    monkeypatch.setattr("backend.config.get_config", lambda: {"market": {"holidays": ["2027-02-30", "2027-03-01"]}})
    assert mc._config_holidays() == {date(2027, 3, 1)}


def test_scheduler_uses_calendar(monkeypatch):
    from backend.services import scheduler

    monkeypatch.setattr(mc, "today_ist", lambda: date(2026, 11, 10))
    assert scheduler.is_market_day() is False
    assert not hasattr(scheduler, "NSE_HOLIDAYS_2026")


def test_candle_timestamps_are_ist():
    ts = int(datetime(2026, 11, 11, 9, 15, tzinfo=IST).timestamp())
    assert dc._ist_naive(ts) == datetime(2026, 11, 11, 9, 15)
    midnight = int(datetime(2026, 11, 11, 0, 0, tzinfo=IST).timestamp())
    assert dc._ist_naive(midnight).date() == date(2026, 11, 11)



def test_calendar_audit_flags_wrong_dates():
    # 9 Nov traded; pretend the calendar (wrongly) still had it as a holiday, and 10 Nov missing
    traded = {date(2026, 11, 6), date(2026, 11, 8), date(2026, 11, 9), date(2026, 11, 11)}
    assert mc.audit_against_sessions(traded, date(2026, 11, 6), date(2026, 11, 11)) == {
        'marked_closed_but_traded': [], 'closed_but_marked_trading': [], 'unlisted_special_sessions': []}
    res = mc.audit_against_sessions(traded - {date(2026, 11, 9)}, date(2026, 11, 6), date(2026, 11, 11))
    assert res['closed_but_marked_trading'] == [date(2026, 11, 9)]


def test_config_special_sessions(monkeypatch):
    monkeypatch.setattr('backend.config.get_config', lambda: {'market': {'special_sessions': [
        {'date': '2027-02-01', 'open': '09:15', 'close': '15:30'}, {'date': 'bad'}]}})
    assert mc.is_trading_day(date(2027, 2, 1)) is True            # a Monday anyway, still listed
    assert date(2027, 2, 1) in mc.special_sessions()
