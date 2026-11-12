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


def _head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    cfg = Config(str(dbm.ROOT_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(dbm.ROOT_DIR / "backend" / "migrations"))
    return ScriptDirectory.from_config(cfg).get_current_head()


def _baseline_only():
    """A database exactly as the baseline migration left it (what pre-Alembic installs looked like)."""
    from alembic import command

    with dbm.get_engine().begin() as c:
        command.upgrade(dbm._alembic_config(c), dbm.BASELINE_REVISION)


def _tables(path):
    c = sqlite3.connect(path)
    try:
        return {r[0] for r in c.execute("select name from sqlite_master where type='table'")}
    finally:
        c.close()


def test_fresh_database_is_built_by_migrations(db_file):
    out = dbm.upgrade_db()
    assert out["revision"] == _head() and out["adopted"] is None
    assert set(dbm.Base.metadata.tables) | {"alembic_version"} == _tables(db_file)
    assert dbm.upgrade_db()["revision"] == _head()      # idempotent


def test_models_match_migrations(db_file):
    """Fails when tables.py changes without a migration: run `alembic revision --autogenerate`."""
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    dbm.upgrade_db()
    with dbm.get_engine().connect() as c:
        assert compare_metadata(MigrationContext.configure(c), dbm.Base.metadata) == []


def test_legacy_database_is_adopted_without_data_loss(db_file):
    # A pre-Alembic DB: an old trades table missing a column, one table missing entirely.
    _baseline_only()
    c = sqlite3.connect(db_file)
    c.execute("drop table alembic_version")
    c.execute("drop table value_candidates")
    c.execute("insert into app_users(username, password_hash, role, is_active) values ('kk', 'h', 'admin', 1)")
    c.execute("alter table sector_scores drop column is_ema_aligned")
    c.commit(); c.close()
    dbm.get_engine().dispose()

    out = dbm.upgrade_db()
    assert out["revision"] == _head()
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

def test_half_applied_swing_migration_recovers(db_file):
    """An interrupted 0002 (SQLite commits DDL per statement) left swing_setups behind at revision 0001."""
    _baseline_only()
    c = sqlite3.connect(db_file)
    c.execute("create table swing_setups (id integer not null primary key, security_id varchar(20) not null, symbol varchar(50) not null, "
              "name varchar(120), setup_type varchar(10) not null, status varchar(16) not null, active boolean not null, "
              "tier varchar(3), score float, components text, reasons text, warnings text, detail text, sector varchar(50), "
              "sector_rank integer, rs_rating integer, regime varchar(12), close float, entry float, stop float, target1 float, "
              "target2 float, risk_pct float, top_pick boolean, dismissed boolean, first_seen date not null, last_seen date not null, "
              "suggested_on date, plan_entry float, plan_stop float, plan_t1 float, plan_t2 float, plan_score float, "
              "plan_tier varchar(3), plan_regime varchar(12), plan_top_pick boolean, eval_status varchar(16), triggered_on date, "
              "fill_price float, exit_on date, exit_price float, result_r float, mfe_r float, mae_r float, days_held integer, "
              "t1_hit boolean, created_at datetime, updated_at datetime)")
    c.commit(); c.close()
    dbm.get_engine().dispose()
    assert dbm.upgrade_db()["revision"] == _head()
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    with dbm.get_engine().connect() as conn:
        assert compare_metadata(MigrationContext.configure(conn), dbm.Base.metadata) == []
