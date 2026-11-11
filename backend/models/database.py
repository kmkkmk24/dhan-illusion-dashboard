import logging
from pathlib import Path

from sqlalchemy import MetaData, create_engine, event, inspect
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from backend.config import get_db_path

logger = logging.getLogger(__name__)

# Seconds a writer waits for another writer's lock before failing with
# "database is locked" (SQLite's default is 5).
SQLITE_BUSY_TIMEOUT_S = 30


def _configure_sqlite(dbapi_conn, _record) -> None:
    """
    Per-connection SQLite settings:
      * WAL: readers never wait for a writer, and writes are faster. The scheduler
        jobs (order protection every 15s, scans, sector/IPO refresh) and the UI
        write concurrently, so this matters.
      * busy_timeout: a writer queues behind another instead of failing.
      * synchronous=NORMAL: the recommended durability level for WAL.
    """
    cur = dbapi_conn.cursor()
    try:
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_S * 1000}")
        cur.execute("PRAGMA synchronous=NORMAL")
    finally:
        cur.close()


class Base(DeclarativeBase):
    pass


_engine = None
_SessionLocal = None


def get_engine():
    global _engine
    if _engine is None:
        db_path = get_db_path()
        _engine = create_engine(
            f"sqlite:///{db_path}",
            connect_args={"check_same_thread": False, "timeout": SQLITE_BUSY_TIMEOUT_S},
            echo=False,
        )
        event.listen(_engine, "connect", _configure_sqlite)
    return _engine


def get_session_factory():
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(
            autocommit=False, autoflush=False, bind=get_engine()
        )
    return _SessionLocal


def get_db():
    """FastAPI dependency that yields a DB session."""
    session_factory = get_session_factory()
    db = session_factory()
    try:
        yield db
    finally:
        db.close()


ROOT_DIR = Path(__file__).resolve().parents[2]
BASELINE_REVISION = "0001"


def _alembic_config(connection):
    from alembic.config import Config

    cfg = Config(str(ROOT_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT_DIR / "backend" / "migrations"))
    cfg.attributes["connection"] = connection
    return cfg


def _baseline_metadata() -> MetaData:
    """
    The schema exactly as the baseline migration creates it (built in a scratch
    in-memory DB), so adoption never jumps ahead of later migrations.
    """
    from alembic import command

    scratch = create_engine("sqlite://")
    try:
        with scratch.begin() as c:
            command.upgrade(_alembic_config(c), BASELINE_REVISION)
            md = MetaData()
            md.reflect(c)
    finally:
        scratch.dispose()
    md.remove(md.tables["alembic_version"])
    return md


def _adopt_legacy_db(connection) -> list[str]:
    """
    A database created before Alembic (tables, no alembic_version): bring it up to
    the baseline schema without touching data (add missing tables, indexes and
    columns), then the caller stamps it at the baseline. Returns what was added.
    """
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    baseline = _baseline_metadata()
    added = []
    for table in baseline.sorted_tables:
        if not inspect(connection).has_table(table.name):
            table.create(connection)
            added.append(f"table {table.name}")
    ctx = MigrationContext.configure(connection)
    for diff in compare_metadata(ctx, baseline):
        if isinstance(diff, tuple) and diff[0] == "add_column":
            _, _, table_name, column = diff
            ddl = column.type.compile(dialect=connection.dialect)
            # Existing rows can't satisfy NOT NULL without a default: add it nullable.
            connection.exec_driver_sql(f'ALTER TABLE "{table_name}" ADD COLUMN "{column.name}" {ddl}')
            added.append(f"column {table_name}.{column.name}")
        elif isinstance(diff, tuple) and diff[0] == "add_index":
            diff[1].create(connection)
            added.append(f"index {diff[1].name}")
    return added


def upgrade_db() -> dict:
    """
    Bring the database to the latest schema with Alembic (runs at startup).
      * new/empty database  -> run every migration from the baseline
      * pre-Alembic database -> add anything missing, stamp the baseline, then upgrade
      * managed database    -> apply pending migrations only
    """
    from alembic import command
    from backend.models import tables  # noqa: F401  (register models)

    engine = get_engine()
    with engine.begin() as conn:
        cfg = _alembic_config(conn)
        names = set(inspect(conn).get_table_names())
        adopted = None
        if "alembic_version" not in names and names & set(Base.metadata.tables):
            adopted = _adopt_legacy_db(conn)
            command.stamp(cfg, BASELINE_REVISION)
            logger.info("Adopted existing database into Alembic at %s; added: %s",
                        BASELINE_REVISION, ", ".join(adopted) or "nothing")
        command.upgrade(cfg, "head")
        version = conn.exec_driver_sql("SELECT version_num FROM alembic_version").scalar()
    logger.info("Database schema at revision %s", version)
    return {"revision": version, "adopted": adopted}


def init_db():
    """Create or migrate the database schema (Alembic)."""
    return upgrade_db()
