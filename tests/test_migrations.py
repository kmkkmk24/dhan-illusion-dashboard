"""Alembic: fresh databases, adopting pre-Alembic databases, and models staying in sync with migrations."""

import sqlite3

import pytest
from sqlalchemy import create_engine, text

import backend.models.database as dbm


@pytest.fixture
def db_file(tmp_path, monkeypatch):
    path = tmp_path / "trades.db"
    monkeypatch.setattr(dbm, "get_db_path", lambda: path)
    monkeypatch.setattr(dbm, "_engine", None)
    monkeypatch.setattr(dbm, "_SessionLocal", None)
    yield path
    if dbm._engine is not None:
        dbm._engine.dispose()


def _tables(path):
    c = sqlite3.connect(path)
    try:
        return {r[0] for r in c.execute("select name from sqlite_master where type='table'")}
    finally:
        c.close()


def test_fresh_database_is_built_by_migrations(db_file):
    out = dbm.upgrade_db()
    assert out["revision"] == dbm.BASELINE_REVISION and out["adopted"] is None
    assert set(dbm.Base.metadata.tables) | {"alembic_version"} == _tables(db_file)
    assert dbm.upgrade_db()["revision"] == dbm.BASELINE_REVISION      # idempotent


def test_models_match_migrations(db_file):
    """Fails when tables.py changes without a migration: run `alembic revision --autogenerate`."""
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    dbm.upgrade_db()
    with dbm.get_engine().connect() as c:
        assert compare_metadata(MigrationContext.configure(c), dbm.Base.metadata) == []


def test_legacy_database_is_adopted_without_data_loss(db_file):
    # A pre-Alembic DB: an old trades table missing a column, one table missing entirely.
    dbm.upgrade_db()
    c = sqlite3.connect(db_file)
    c.execute("drop table alembic_version")
    c.execute("drop table value_candidates")
    c.execute("insert into app_users(username, password_hash, role, is_active) values ('kk', 'h', 'admin', 1)")
    c.execute("alter table sector_scores drop column is_ema_aligned")
    c.commit(); c.close()
    dbm.get_engine().dispose()

    out = dbm.upgrade_db()
    assert out["revision"] == dbm.BASELINE_REVISION
    assert "table value_candidates" in out["adopted"] and "column sector_scores.is_ema_aligned" in out["adopted"]
    with dbm.get_engine().connect() as conn:
        assert conn.execute(text("select username from app_users")).scalar() == "kk"
        conn.execute(text("select is_ema_aligned from sector_scores"))       # column exists again
    # A second start is a plain upgrade, nothing to adopt.
    assert dbm.upgrade_db()["adopted"] is None


def test_restore_of_pre_alembic_backup_is_migrated(db_file, tmp_path, monkeypatch):
    import backend.services.backup_manager as bm

    dbm.upgrade_db()
    bdir = tmp_path / "backups"; bdir.mkdir()
    old = bdir / "trades_old.db"
    c = sqlite3.connect(old)
    c.execute("create table trades (id integer primary key, symbol text)")
    c.commit(); c.close()
    monkeypatch.setattr(bm, "get_backup_path", lambda: bdir)
    monkeypatch.setattr(bm, "get_db_path", lambda: db_file)
    bm.restore_backup("trades_old.db")
    assert {"alembic_version", "trades", "instruments"} <= _tables(db_file)
