"""SQLite runs in WAL mode with a lock wait; backups of a WAL database stay complete single files."""

import sqlite3
import threading

import pytest
from sqlalchemy import text

import backend.models.database as dbm
import backend.services.backup_manager as bm


@pytest.fixture
def live_engine(tmp_path, monkeypatch):
    path = tmp_path / "trades.db"
    monkeypatch.setattr(dbm, "get_db_path", lambda: path)
    monkeypatch.setattr(dbm, "_engine", None)
    monkeypatch.setattr(dbm, "_SessionLocal", None)
    engine = dbm.get_engine()
    yield engine, path
    engine.dispose()


def test_engine_uses_wal_and_busy_timeout(live_engine):
    engine, _ = live_engine
    with engine.connect() as c:
        assert c.execute(text("PRAGMA journal_mode")).scalar() == "wal"
        assert c.execute(text("PRAGMA busy_timeout")).scalar() == dbm.SQLITE_BUSY_TIMEOUT_S * 1000
        assert c.execute(text("PRAGMA synchronous")).scalar() == 1   # NORMAL


def test_reader_is_not_blocked_by_an_open_write(live_engine):
    engine, path = live_engine
    with engine.begin() as c:
        c.execute(text("create table trades (id integer primary key, note text)"))
        c.execute(text("insert into trades(note) values ('a')"))
    writer = engine.connect()
    tx = writer.begin()
    writer.execute(text("insert into trades(note) values ('b')"))       # holds the write lock
    result = {}

    def read():
        r = sqlite3.connect(str(path), timeout=0.2)                     # would raise if blocked
        result["rows"] = r.execute("select count(*) from trades").fetchone()[0]
        r.close()

    t = threading.Thread(target=read)
    t.start(); t.join(5)
    tx.rollback(); writer.close()
    assert result["rows"] == 1                                           # sees the last commit, no lock error


def test_backup_of_wal_db_is_complete_single_file(live_engine, tmp_path, monkeypatch):
    engine, path = live_engine
    with engine.begin() as c:
        c.execute(text("create table trades (id integer primary key, note text)"))
        c.execute(text("insert into trades(note) values ('only-in-wal')"))
    keep_open = engine.connect()        # keeps the WAL un-checkpointed, like the running app
    try:
        monkeypatch.setattr(bm, "get_db_path", lambda: path)
        monkeypatch.setattr(bm, "_enforce_retention_policy", lambda d: None)
        info = bm.create_backup(str(tmp_path / "bk"))
        b = sqlite3.connect(info["path"])
        try:
            assert b.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
            assert b.execute("select note from trades").fetchone()[0] == "only-in-wal"
        finally:
            b.close()
    finally:
        keep_open.close()
