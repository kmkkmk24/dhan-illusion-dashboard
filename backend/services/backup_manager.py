"""
Database backup manager with configurable path and retention policy.

Uses SQLite's online backup API for safe, consistent copies
even while the application is running.
"""

import logging
import re
import sqlite3
from datetime import datetime
from pathlib import Path

from backend.config import DATA_DIR, get_config, get_db_path

logger = logging.getLogger(__name__)


_BACKUP_NAME_RE = re.compile(r"^trades_[A-Za-z0-9_-]+\.db$")
_SQLITE_HEADER = b"SQLite format 3\x00"


def get_backup_path() -> Path:
    """Configured backup directory, or data/backups when none is set."""
    config = get_config()
    backup_path = (config.get("backup") or {}).get("path", "")
    return Path(backup_path) if backup_path else DATA_DIR / "backups"


def _sqlite_copy(src_path: Path, dst_path: Path, *, single_file: bool = True) -> None:
    """
    Copy one SQLite database into another with the online backup API (reads
    through the live DB's WAL, so recent commits are included). A backup file is
    switched to rollback-journal mode so it stays one self-contained file.
    """
    from backend.models.database import SQLITE_BUSY_TIMEOUT_S

    src = sqlite3.connect(str(src_path), timeout=SQLITE_BUSY_TIMEOUT_S)
    dst = sqlite3.connect(str(dst_path), timeout=SQLITE_BUSY_TIMEOUT_S)
    try:
        src.backup(dst)
        if single_file:
            dst.execute("PRAGMA journal_mode=DELETE")
    finally:
        dst.close()
        src.close()


def _resolve_backup_file(backup_dir: Path, backup_filename: str) -> Path:
    """
    Only accept a bare file name of the form trades_*.db that resolves inside
    the backup directory (blocks ../ traversal and absolute paths).
    """
    name = str(backup_filename or "")
    if not _BACKUP_NAME_RE.match(name):
        raise ValueError("Invalid backup file name")
    root = backup_dir.resolve()
    target = (root / name).resolve()
    if target.parent != root:
        raise ValueError("Invalid backup file name")
    if not target.is_file():
        raise FileNotFoundError(f"Backup file not found: {name}")
    return target


def _validate_sqlite_backup(path: Path) -> None:
    """Make sure the file really is a healthy SQLite DB with a trades table."""
    with open(path, "rb") as f:
        if f.read(16) != _SQLITE_HEADER:
            raise ValueError("Not a SQLite database file")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Backup failed SQLite integrity check")
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trades'").fetchone():
            raise ValueError("Backup has no trades table")
    finally:
        conn.close()


def create_backup(custom_path: str | None = None) -> dict:
    """
    Create a backup of the SQLite database.

    Uses sqlite3.backup() for a safe, consistent copy that works
    even while the database is being written to.

    Returns info about the created backup.
    """
    db_path = get_db_path()
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found at {db_path}")

    backup_dir = Path(custom_path) if custom_path else get_backup_path()
    backup_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    backup_filename = f"trades_{timestamp}.db"
    backup_filepath = backup_dir / backup_filename

    _sqlite_copy(db_path, backup_filepath)

    size_mb = backup_filepath.stat().st_size / (1024 * 1024)

    logger.info(f"Backup created: {backup_filepath} ({size_mb:.2f} MB)")

    _enforce_retention_policy(backup_dir)

    return {
        "filename": backup_filename,
        "path": str(backup_filepath),
        "size_mb": round(size_mb, 2),
        "created_at": timestamp,
    }


def _enforce_retention_policy(backup_dir: Path) -> None:
    """Delete old backups beyond the configured retention count."""
    config = get_config()
    keep_last = config.get("backup", {}).get("keep_last", 30)

    backups = sorted(
        [f for f in backup_dir.glob("trades_*.db")],
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )

    if len(backups) > keep_last:
        for old_backup in backups[keep_last:]:
            old_backup.unlink()
            logger.info(f"Deleted old backup: {old_backup.name}")


def list_backups() -> list[dict]:
    """List all available backups."""
    backup_dir = get_backup_path()
    if not backup_dir.exists():
        return []

    backups = sorted(
        backup_dir.glob("trades_*.db"),
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )

    return [
        {
            "filename": f.name,
            "path": str(f),
            "size_mb": round(f.stat().st_size / (1024 * 1024), 2),
            "created_at": datetime.fromtimestamp(f.stat().st_mtime).strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
        }
        for f in backups
    ]


def restore_backup(backup_filename: str) -> dict:
    """
    Restore the database from a backup file in the backup directory.

    The current database is first saved as trades_pre_restore_<timestamp>.db.
    Uses SQLite's backup API (not a file copy) so the live DB is replaced
    consistently even with open connections; the SQLAlchemy pool is then reset.
    """
    backup_dir = get_backup_path()
    backup_filepath = _resolve_backup_file(backup_dir, backup_filename)
    _validate_sqlite_backup(backup_filepath)

    db_path = get_db_path()
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")

    if db_path.exists():
        pre_restore_path = backup_dir / f"trades_pre_restore_{stamp}.db"
        _sqlite_copy(db_path, pre_restore_path)
        logger.info(f"Pre-restore backup created: {pre_restore_path}")

    # Into the live DB: keep its mode; reconnecting re-applies WAL + busy_timeout.
    _sqlite_copy(backup_filepath, db_path, single_file=False)

    from backend.models.database import get_engine, upgrade_db
    get_engine().dispose()
    logger.info(f"Database restored from: {backup_filepath}")
    # An older backup may predate the current schema (or Alembic): migrate it now.
    try:
        upgrade_db()
    except Exception as e:
        logger.error("Schema upgrade after restore failed: %s", e, exc_info=True)

    return {
        "restored_from": backup_filepath.name,
        "restored_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def export_trades_csv(db_path_override: str | None = None) -> str:
    """Export the trades table to a CSV file in the backup directory."""
    import pandas as pd
    from sqlalchemy import create_engine

    db_path = Path(db_path_override) if db_path_override else get_db_path()
    engine = create_engine(f"sqlite:///{db_path}")

    df = pd.read_sql_table("trades", engine)

    export_dir = get_backup_path()
    export_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    csv_path = export_dir / f"trades_export_{timestamp}.csv"
    df.to_csv(csv_path, index=False)

    logger.info(f"Trades exported to CSV: {csv_path}")
    return str(csv_path)
