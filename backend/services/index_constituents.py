"""
Official NSE sectoral index constituents.

Source of truth: the per-index constituent CSVs published on niftyindices.com.
  * A bundled snapshot (index_constituents_snapshot.py) works offline.
  * refresh_constituents() downloads the current lists and caches them in
    data/cache/index_constituents.json; that cache wins over the snapshot.
A sector whose download fails keeps its previous list, so a partial outage
never empties a sector.

Records are {"symbol", "isin", "company", "industry"}. Match stocks to Dhan
instruments by ISIN first (survives ticker renames), then by symbol.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

import httpx

from backend.services.index_constituents_snapshot import SNAPSHOT, SNAPSHOT_AS_OF

logger = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
BASE_URL = "https://www.niftyindices.com/IndexConstituent/{file}.csv"
SECTOR_SOURCES: dict[str, str] = {
    "Nifty Auto": "ind_niftyautolist",
    "Nifty Bank": "ind_niftybanklist",
    "Nifty Capital Markets": "ind_niftycapitalmarkets_list",
    "Nifty Commodities": "ind_niftycommoditieslist",
    "Nifty Consumer Durables": "ind_niftyconsumerdurableslist",
    "Nifty Energy": "ind_niftyenergylist",
    "Nifty Fin Services": "ind_niftyfinancelist",
    "Nifty FMCG": "ind_niftyfmcglist",
    "Nifty Healthcare": "ind_niftyhealthcarelist",
    "Nifty Infra": "ind_niftyinfralist",
    "Nifty IT": "ind_niftyitlist",
    "Nifty Media": "ind_niftymedialist",
    "Nifty Metal": "ind_niftymetallist",
    "Nifty Oil & Gas": "ind_niftyoilgaslist",
    "Nifty PSU Bank": "ind_niftypsubanklist",
    "Nifty Pharma": "ind_niftypharmalist",
    "Nifty Private Bank": "ind_nifty_privatebanklist",
    "Nifty Realty": "ind_niftyrealtylist",
    # Thematic indices (after the sectoral ones, so a stock's primary sector stays sectoral)
    "Nifty India Defence": "ind_niftyindiadefence_list",
    "Nifty CPSE": "ind_niftycpselist",
    "Nifty IPO": "ind_niftyipo_list",
    "Nifty New Age Consumption": "ind_niftyindianewageconsumption_list",
    "Nifty EV & New Age Auto": "ind_niftyEV_NewAgeAutomotive_list",
    "Nifty Housing": "ind_niftyhousing_list",
    "Nifty India Digital": "ind_niftyindiadigital_list",
    "Nifty India Tourism": "ind_niftyindiatourism_list",
    "Nifty MNC": "ind_niftymnclist",
}
_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"}
_MIN_ROWS = 5  # sanity floor: every tracked index has at least 10 constituents

_cache: Optional[dict] = None


def _cache_path() -> Path:
    from backend.config import DATA_DIR

    return DATA_DIR / "cache" / "index_constituents.json"


def _snapshot_payload() -> dict:
    return {
        "source": "snapshot",
        "as_of": SNAPSHOT_AS_OF,
        "fetched_at": None,
        "sectors": {
            sector: [{"symbol": s, "isin": i, "company": c, "industry": ind} for s, i, c, ind in rows]
            for sector, rows in SNAPSHOT.items()
        },
    }


def load() -> dict:
    """Current constituents payload: downloaded cache if present and valid, else the snapshot."""
    global _cache
    if _cache is not None:
        return _cache
    payload = _snapshot_payload()
    path = _cache_path()
    if path.exists():
        try:
            cached = json.loads(path.read_text(encoding="utf-8"))
            sectors = cached.get("sectors") or {}
            if isinstance(sectors, dict) and sectors:
                # Sectors missing from the cache fall back to the snapshot.
                payload = {**cached, "sectors": {**payload["sectors"], **sectors}}
        except Exception as e:
            logger.warning("Ignoring unreadable constituents cache %s: %s", path, e)
    _cache = payload
    return _cache


def invalidate() -> None:
    global _cache
    _cache = None


def sectors() -> dict[str, list[dict]]:
    return load()["sectors"]


def parse_csv(text: str) -> list[dict]:
    """Parse a niftyindices constituent CSV into records (raises ValueError if malformed)."""
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    if not reader.fieldnames or "Symbol" not in reader.fieldnames or "ISIN Code" not in reader.fieldnames:
        raise ValueError("unexpected CSV header")
    rows = [
        {
            "symbol": (r.get("Symbol") or "").strip(),
            "isin": (r.get("ISIN Code") or "").strip(),
            "company": (r.get("Company Name") or r.get("Company") or "").strip(),
            "industry": (r.get("Industry") or "").strip(),
        }
        for r in reader
        if (r.get("Symbol") or "").strip()
    ]
    if len(rows) < _MIN_ROWS:
        raise ValueError(f"only {len(rows)} rows")
    return rows


def _write_cache(payload: dict) -> None:
    path = _cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    except Exception:
        Path(tmp).unlink(missing_ok=True)
        raise


async def refresh_constituents(client: Optional[httpx.AsyncClient] = None) -> dict:
    """
    Download every tracked index's constituent list from niftyindices.com.
    Sectors that fail keep their previous list. Returns a summary.
    """
    current = load()
    updated: dict[str, list[dict]] = {}
    failures: dict[str, str] = {}
    own_client = client is None
    client = client or httpx.AsyncClient(timeout=20.0, headers=_HEADERS, follow_redirects=True)
    try:
        for sector, file in SECTOR_SOURCES.items():
            try:
                resp = await client.get(BASE_URL.format(file=file))
                resp.raise_for_status()
                updated[sector] = parse_csv(resp.text)
            except Exception as e:
                failures[sector] = str(e)[:200]
                logger.warning("Constituents download failed for %s: %s", sector, e)
    finally:
        if own_client:
            await client.aclose()

    if updated:
        now = datetime.now(IST)
        payload = {
            "source": "niftyindices.com",
            "as_of": now.date().isoformat(),
            "fetched_at": now.isoformat(timespec="seconds"),
            "sectors": {**current["sectors"], **updated},
            "failures": failures,
        }
        _write_cache(payload)
        invalidate()
        from backend.services import sector_mapping

        sector_mapping.reload()

    return {
        "updated_sectors": len(updated),
        "total_sectors": len(SECTOR_SOURCES),
        "failed_sectors": sorted(failures),
        "stocks": sum(len(v) for v in sectors().values()),
        "as_of": load().get("as_of"),
        "source": load().get("source"),
    }
