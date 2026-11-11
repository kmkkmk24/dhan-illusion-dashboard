"""
Sector-to-stock mapping for NSE sectoral indices.

Backed by the official NSE constituent lists (see index_constituents.py):
a bundled snapshot, replaced by the current lists whenever "Refresh
Instruments" downloads them. Used to:
  1. Tag each instrument with its sector
  2. Restrict sector-first scans to stocks in the strongest sectors
  3. List a sector's stocks in the Sectors tab and Telegram drill-downs

The public names below are kept stable for existing callers. The module-level
dicts are updated *in place* by reload(), so `from ... import STOCK_TO_SECTORS`
references stay current.
"""

import logging

from sqlalchemy import or_
from sqlalchemy.orm import Session

from backend.models.tables import Instrument
from backend.services import index_constituents

logger = logging.getLogger(__name__)

# sector -> [NSE symbol, ...]
SECTOR_CONSTITUENTS: dict[str, list[str]] = {}
# NSE symbol -> [sector, ...]
STOCK_TO_SECTORS: dict[str, list[str]] = {}
# ISIN -> [sector, ...]   (robust to ticker renames)
ISIN_TO_SECTORS: dict[str, list[str]] = {}


def reload() -> None:
    """Rebuild the lookup tables from the current constituent lists."""
    sectors = index_constituents.sectors()
    SECTOR_CONSTITUENTS.clear()
    STOCK_TO_SECTORS.clear()
    ISIN_TO_SECTORS.clear()
    for sector, rows in sectors.items():
        SECTOR_CONSTITUENTS[sector] = [r["symbol"] for r in rows]
        for r in rows:
            STOCK_TO_SECTORS.setdefault(r["symbol"].upper(), []).append(sector)
            if r.get("isin"):
                ISIN_TO_SECTORS.setdefault(r["isin"].upper(), []).append(sector)


reload()


def constituents_info() -> dict:
    """Where the lists came from: {"source", "as_of", "fetched_at"}."""
    data = index_constituents.load()
    return {k: data.get(k) for k in ("source", "as_of", "fetched_at")}


def get_all_sector_names() -> list[str]:
    """Return all tracked sector names."""
    return list(SECTOR_CONSTITUENTS.keys())


def get_constituents(sector_name: str) -> list[dict]:
    """Full records ({symbol, isin, company, industry}) for a sector, in NSE's order."""
    return list(index_constituents.sectors().get(sector_name, []))


def get_stocks_in_sector(sector_name: str) -> list[str]:
    """Return stock symbols belonging to a sector."""
    return list(SECTOR_CONSTITUENTS.get(sector_name, []))


def get_stocks_in_sectors(sector_names: list[str]) -> list[str]:
    """Return unique stock symbols across multiple sectors."""
    symbols = set()
    for sector in sector_names:
        symbols.update(SECTOR_CONSTITUENTS.get(sector, []))
    return list(symbols)


def get_sectors_for_stock(symbol: str) -> list[str]:
    """Return which sectors a stock belongs to (accepts an NSE symbol or an ISIN)."""
    key = str(symbol or "").strip().upper()
    return list(STOCK_TO_SECTORS.get(key) or ISIN_TO_SECTORS.get(key) or [])


def sectors_for_instrument(instrument: Instrument) -> list[str]:
    """Sectors for an instrument, matching by ISIN first, then by trading symbol."""
    isin = str(instrument.isin or "").strip().upper()
    if isin and isin in ISIN_TO_SECTORS:
        return list(ISIN_TO_SECTORS[isin])
    return get_sectors_for_stock(instrument.trading_symbol or instrument.symbol)


def update_instrument_sectors(db: Session) -> int:
    """
    Set each NSE equity's primary sector from the constituent lists (ISIN first,
    then trading symbol) and clear sectors of stocks that left every index.
    Returns the number of instruments changed.
    """
    tracked = set(SECTOR_CONSTITUENTS)
    updated = 0
    for inst in db.query(Instrument).filter(Instrument.exchange == "NSE", Instrument.segment == "E"):
        sectors = sectors_for_instrument(inst)
        new = sectors[0] if sectors else (None if inst.sector in tracked else inst.sector)
        if inst.sector != new:
            inst.sector = new
            updated += 1
    db.commit()
    logger.info(f"Updated sector mapping for {updated} instruments")
    return updated


def get_sector_instruments(db: Session, sector_names: list[str]) -> list[Instrument]:
    """Get Instrument objects for stocks in the given sectors (ISIN or symbol match)."""
    symbols, isins = set(), set()
    for sector in sector_names:
        for r in index_constituents.sectors().get(sector, []):
            symbols.add(r["symbol"])
            if r.get("isin"):
                isins.add(r["isin"])
    if not symbols:
        return []
    return db.query(Instrument).filter(
        Instrument.exchange == "NSE",
        or_(Instrument.trading_symbol.in_(symbols), Instrument.isin.in_(isins)),
    ).all()


def sector_stocks(db: Session, sector_name: str) -> dict:
    """
    Every official constituent of a sector, matched to Dhan instruments (ISIN
    first, then NSE symbol), with F&O status, lot size and active signal.
    Constituents not on Dhan are kept and flagged. Order: signals, F&O, the rest.
    """
    from backend.models.tables import Signal

    rows = get_constituents(sector_name)
    info = constituents_info()
    if not rows:
        return {"sector": sector_name, **info, "total": 0, "fno_count": 0, "stocks": []}

    symbols = [r["symbol"] for r in rows]
    isins = [r["isin"] for r in rows if r.get("isin")]
    instruments = db.query(Instrument).filter(
        Instrument.exchange == "NSE",
        or_(Instrument.isin.in_(isins), Instrument.trading_symbol.in_(symbols)),
    ).all()
    by_isin = {str(i.isin or "").upper(): i for i in instruments if i.isin}
    by_symbol = {str(i.trading_symbol or "").upper(): i for i in instruments if i.trading_symbol}

    matched_ids = [i.security_id for i in instruments]
    active_signals = db.query(Signal).filter(
        Signal.security_id.in_(matched_ids),
        Signal.status.in_(["active", "exploded"]),
    ).all() if matched_ids else []
    signal_map = {s.security_id: s for s in active_signals}

    stocks = []
    for r in rows:
        inst = by_isin.get(r["isin"].upper()) or by_symbol.get(r["symbol"].upper())
        sig = signal_map.get(inst.security_id) if inst else None
        stocks.append({
            "symbol": r["symbol"],
            "display_name": (inst.display_name if inst and inst.display_name else r["company"]),
            "company": r["company"],
            "industry": r["industry"],
            "isin": r["isin"],
            "in_dhan": inst is not None,
            "security_id": inst.security_id if inst else None,
            "is_fno": bool(inst and inst.is_fno),
            "lot_size": inst.lot_size if inst and inst.is_fno else None,
            "has_signal": sig is not None,
            "signal_status": sig.status if sig else None,
            "signal_score": sig.current_score if sig else None,
            "signal_type": sig.signal_type if sig else None,
            "occurrence_number": sig.occurrence_number if sig else None,
        })

    # Signals first, then F&O stocks, then the rest (NSE order within each group).
    stocks.sort(key=lambda x: (not x["has_signal"], -(x["signal_score"] or 0), not x["is_fno"]))
    return {
        "sector": sector_name,
        **info,
        "total": len(stocks),
        "fno_count": sum(1 for x in stocks if x["is_fno"]),
        "stocks": stocks,
    }
