"""
Manages the instrument master list, including F&O stock identification.

Downloads the Dhan scrip master CSV, parses it, identifies F&O eligible stocks,
and caches everything in the local SQLite database.
"""

import logging
from datetime import datetime

import pandas as pd
from sqlalchemy import func
from sqlalchemy.orm import Session
from typing import Optional

from backend.models.tables import Instrument
from backend.services.dhan_client import download_scrip_master

logger = logging.getLogger(__name__)

# NSE sector index mapping (Nifty sectoral indices)
# Security IDs for sector indices will be loaded from the scrip master
SECTOR_INDICES = {
    "NIFTY BANK": "Nifty Bank",
    "NIFTY IT": "Nifty IT",
    "NIFTY PHARMA": "Nifty Pharma",
    "NIFTY AUTO": "Nifty Auto",
    "NIFTY FMCG": "Nifty FMCG",
    "NIFTY METAL": "Nifty Metal",
    "NIFTY REALTY": "Nifty Realty",
    "NIFTY ENERGY": "Nifty Energy",
    "NIFTY INFRA": "Nifty Infra",
    "NIFTY PSU BANK": "Nifty PSU Bank",
    "NIFTY MEDIA": "Nifty Media",
    "NIFTY COMMODITIES": "Nifty Commodities",
    "NIFTY CONSUMPTION": "Nifty Consumption",
    "NIFTY FIN SERVICE": "Nifty Financial Services",
    "NIFTY HEALTHCARE": "Nifty Healthcare",
}


async def refresh_instruments(db: Session) -> dict:
    """
    Download the latest scrip master and update the instruments table.
    Returns a summary of the refresh operation.
    """
    df = await download_scrip_master()

    # Filter for NSE equity cash segment
    equity_df = df[
        (df["EXCH_ID"] == "NSE")
        & (df["SEGMENT"] == "E")
        & (df["INSTRUMENT"].isin(["EQUITY", "ETF"]))
    ].copy()

    # Identify F&O eligible stocks: find unique underlying symbols in the
    # derivatives segment of the scrip master
    fno_df = df[
        (df["EXCH_ID"] == "NSE")
        & (df["SEGMENT"] == "D")
    ]
    fno_symbols = set(fno_df["UNDERLYING_SYMBOL"].dropna().unique())

    # Build mapping: UNDERLYING_SECURITY_ID -> NSE trading symbol (e.g., 1333 -> HDFCBANK)
    fno_trading_symbols = {}
    for _, row in fno_df.drop_duplicates("UNDERLYING_SYMBOL").iterrows():
        usid = row.get("UNDERLYING_SECURITY_ID")
        usym = row.get("UNDERLYING_SYMBOL")
        if pd.notna(usid) and pd.notna(usym):
            fno_trading_symbols[str(int(usid))] = str(usym)

    # F&O lot size per underlying security id, from stock futures (nearest live expiry).
    fno_lots = _fno_lot_sizes(fno_df)

    logger.info(f"Found {len(equity_df)} NSE equity instruments, {len(fno_symbols)} F&O symbols")

    added = 0
    updated = 0

    for _, row in equity_df.iterrows():
        security_id = str(row.get("SEM_SMST_SECURITY_ID", row.get("SECURITY_ID", "")))
        if not security_id:
            continue

        symbol = str(row.get("SYMBOL_NAME", row.get("SM_SYMBOL_NAME", "")))
        display_name = str(row.get("DISPLAY_NAME", row.get("SEM_CUSTOM_SYMBOL", symbol)))
        instrument_type = str(row.get("INSTRUMENT_TYPE", row.get("SEM_EXCH_INSTRUMENT_TYPE", "")))
        # F&O stocks use the futures lot size; cash-only stocks keep 1.
        # (Set here in the same pass: a separate post-step looked rows up by
        # trading_symbol before new rows were flushed, so a first refresh left
        # every F&O lot at 1.)
        lot_size = fno_lots.get(security_id, 1)
        isin = str(row.get("ISIN", ""))
        is_fno = security_id in fno_trading_symbols
        # NSE ticker for every equity (Dhan's UNDERLYING_SYMBOL), not only F&O stocks;
        # sector lookups and displays key on this, and non-F&O stocks used to fall
        # back to Dhan's company-style SYMBOL_NAME and never matched a sector.
        ticker = row.get("UNDERLYING_SYMBOL")
        trading_symbol = fno_trading_symbols.get(security_id) or (
            str(ticker).strip() if pd.notna(ticker) and str(ticker).strip() else None
        )

        existing = db.query(Instrument).filter(Instrument.security_id == security_id).first()

        if existing:
            existing.symbol = symbol
            existing.display_name = display_name
            existing.instrument_type = instrument_type
            existing.lot_size = lot_size
            existing.isin = isin
            existing.is_fno = is_fno
            if trading_symbol:
                existing.trading_symbol = trading_symbol
            existing.updated_at = datetime.utcnow()
            updated += 1
        else:
            instrument = Instrument(
                security_id=security_id,
                exchange="NSE",
                segment="E",
                symbol=symbol,
                trading_symbol=trading_symbol,
                display_name=display_name,
                instrument_type=instrument_type,
                lot_size=lot_size,
                isin=isin,
                is_fno=is_fno,
            )
            db.add(instrument)
            added += 1

    db.commit()

    summary = {
        "total_equity": len(equity_df),
        "fno_symbols": len(fno_symbols),
        "added": added,
        "updated": updated,
    }
    logger.info(f"Instrument refresh complete: {summary}")
    return summary


def _fno_lot_sizes(fno_df: pd.DataFrame) -> dict[str, int]:
    """
    Map underlying (cash) security id -> current F&O lot size.

    Uses stock futures; when NSE revises a lot size, contracts of different
    expiries carry different lots, so the nearest live expiry wins.
    """
    fut = fno_df[fno_df["INSTRUMENT"] == "FUTSTK"].copy()
    if fut.empty:
        return {}
    fut["_exp"] = pd.to_datetime(fut.get("SM_EXPIRY_DATE"), errors="coerce")
    today = pd.Timestamp(datetime.now().date())
    live = fut[fut["_exp"] >= today]
    fut = (live if not live.empty else fut).sort_values("_exp")
    lots: dict[str, int] = {}
    for _, row in fut.iterrows():
        usid, lot = row.get("UNDERLYING_SECURITY_ID"), row.get("LOT_SIZE")
        if pd.isna(usid) or pd.isna(lot):
            continue
        key = str(int(usid))
        if key in lots:
            continue  # keep the nearest expiry
        try:
            value = int(float(lot))
        except (TypeError, ValueError):
            continue
        if value > 0:
            lots[key] = value
    return lots


def get_fno_stocks(db: Session) -> list[Instrument]:
    """Return all F&O eligible stocks."""
    return db.query(Instrument).filter(Instrument.is_fno == True).all()  # noqa: E712


def get_all_equity_stocks(db: Session) -> list[Instrument]:
    """Return all NSE segment-E rows (includes bonds, MF, ES, etc.)."""
    return db.query(Instrument).filter(
        Instrument.exchange == "NSE",
        Instrument.segment == "E",
    ).all()


def get_fno_lot_size_for_underlying(db: Session, instrument: Optional[Instrument]) -> int:
    """
    Shares per F&O lot for this underlying (used for option premium P&L).

    Populated from scrip refresh via F&O lot sizes. Returns 1 if unknown — callers
    should treat P&L as per-share unless lot_size > 1.
    """
    if not instrument:
        return 1
    if instrument.lot_size and instrument.lot_size > 1:
        return int(instrument.lot_size)
    sym = (instrument.trading_symbol or "").strip()
    if not sym:
        return 1
    row = (
        db.query(Instrument)
        .filter(
            Instrument.exchange == "NSE",
            Instrument.segment == "E",
            func.upper(Instrument.trading_symbol) == sym.upper(),
            Instrument.lot_size > 1,
        )
        .first()
    )
    if row:
        return int(row.lot_size)
    return 1


def get_nse_cash_equity_shares(db: Session) -> list[Instrument]:
    """
    Ordinary NSE cash equities (instrument_type ES only).

    Dhan /charts/historical with NSE_EQ + EQUITY fails with HTTP 400 for DEB/DBT/MF/etc.
    Use this for swing/VCP scans.
    """
    return db.query(Instrument).filter(
        Instrument.exchange == "NSE",
        Instrument.segment == "E",
        Instrument.instrument_type == "ES",
    ).all()


def search_instruments(db: Session, query: str, limit: int = 20) -> list[Instrument]:
    """Search instruments by symbol or display name."""
    search_term = f"%{query.upper()}%"
    return db.query(Instrument).filter(
        (Instrument.symbol.like(search_term))
        | (Instrument.display_name.like(search_term))
    ).limit(limit).all()
