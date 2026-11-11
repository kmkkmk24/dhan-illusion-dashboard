"""IPO tracker API: main-board IPOs since Nov 2021 with all-time-high distance."""

import asyncio
import logging

from fastapi import APIRouter, Query

from backend.services import ipo_tracker

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ipos", tags=["ipos"])

_task: asyncio.Task | None = None


@router.get("")
def list_ipos():
    data = ipo_tracker.load()
    ipos = data.get("ipos", [])
    return {
        "available": bool(ipos),
        "as_of": data.get("as_of"),
        "since": data.get("since") or ipo_tracker.cutoff_date().isoformat(),
        "list_fetched_at": data.get("list_fetched_at"),
        "prices_updated_at": data.get("prices_updated_at"),
        "list_error": data.get("list_error"),
        "source": data.get("source"),
        "thresholds": {"at_ath": ipo_tracker.AT_ATH, "near_ath": ipo_tracker.NEAR_ATH},
        "ipos": ipos,
        "status": ipo_tracker.status,
    }


@router.get("/status")
def refresh_status():
    return ipo_tracker.status


async def _run(full: bool) -> None:
    from backend.models.database import get_session_factory

    db = get_session_factory()()
    try:
        await ipo_tracker.refresh(db, full=full)
    finally:
        db.close()


@router.post("/refresh")
async def start_refresh(full: bool = Query(False, description="Reload every stock's history from its listing day")):
    """Start a background refresh; poll /status for progress."""
    global _task
    if ipo_tracker.status.get("running") or (_task and not _task.done()):
        return {"started": False, "detail": "A refresh is already running", "status": ipo_tracker.status}
    ipo_tracker.status.update(running=True, phase="starting", done=0, total=0, error=None)
    _task = asyncio.create_task(_run(full))
    return {"started": True, "status": ipo_tracker.status}
