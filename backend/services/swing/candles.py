"""
Local daily-candle store for the swing engine.

Each stock's history lives in data/swing/candles/<security_id>.pkl. A stock is
back-filled from Dhan once (~3 years); after that it is kept current from the
NSE bhavcopy (one download per day for every stock), which also adds the
delivery %. Dhan is only called again for a stock that is new to the universe or
has a gap the bhavcopy cannot fill.

Corporate actions: the bhavcopy's PREV_CLOSE is adjusted on the ex-date. When it
disagrees with the stored close for the previous session by more than 2%, the
stored history is rescaled (prices x ratio, volume / ratio), so splits and
bonuses never show up as fake crashes.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)

COLUMNS = ["timestamp", "open", "high", "low", "close", "volume", "deliv_pct"]
SPLIT_TOLERANCE = 0.02


def store_dir() -> Path:
    from backend.config import DATA_DIR

    p = DATA_DIR / "swing" / "candles"
    p.mkdir(parents=True, exist_ok=True)
    return p


def normalize(df: Optional[pd.DataFrame]) -> Optional[pd.DataFrame]:
    if df is None or df.empty:
        return None
    out = df.copy()
    out["timestamp"] = pd.to_datetime(out["timestamp"]).dt.tz_localize(None).dt.normalize()
    for c in COLUMNS[1:]:
        if c not in out.columns:
            out[c] = float("nan")
        out[c] = pd.to_numeric(out[c], errors="coerce")
    out = out[COLUMNS].dropna(subset=["open", "high", "low", "close"])
    return out.drop_duplicates("timestamp", keep="last").sort_values("timestamp").reset_index(drop=True)


def merge(old: Optional[pd.DataFrame], new: Optional[pd.DataFrame]) -> Optional[pd.DataFrame]:
    """Union by date; rows from `new` win, but a NaN delivery % never overwrites a known one."""
    old, new = normalize(old), normalize(new)
    if old is None:
        return new
    if new is None:
        return old
    both = pd.concat([old, new], ignore_index=True)
    deliv = both.dropna(subset=["deliv_pct"]).drop_duplicates("timestamp", keep="last").set_index("timestamp")["deliv_pct"]
    out = both.drop_duplicates("timestamp", keep="last").sort_values("timestamp").reset_index(drop=True)
    out["deliv_pct"] = out["timestamp"].map(deliv)
    return out


def adjust_for_corporate_action(df: pd.DataFrame, ratio: float) -> pd.DataFrame:
    out = df.copy()
    for c in ("open", "high", "low", "close"):
        out[c] = out[c] * ratio
    out["volume"] = out["volume"] / ratio
    return out


class CandleStore:
    def __init__(self, root: Optional[Path] = None):
        self.root = Path(root) if root else store_dir()
        self.root.mkdir(parents=True, exist_ok=True)
        self._meta_path = self.root / "_meta.json"
        try:
            self.meta = json.loads(self._meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.meta = {}
        self.meta.setdefault("stocks", {})

    # ── files ──
    def _path(self, key: str) -> Path:
        return self.root / f"{key}.pkl"

    def load(self, key: str) -> Optional[pd.DataFrame]:
        p = self._path(key)
        if not p.is_file():
            return None
        try:
            return pd.read_pickle(p)
        except Exception as e:  # corrupt file: drop it so it is back-filled again
            logger.warning("Candle file %s unreadable (%s); will refetch", p.name, e)
            p.unlink(missing_ok=True)
            return None

    def save(self, key: str, df: pd.DataFrame, **info) -> None:
        df = normalize(df)
        if df is None:
            return
        fd, tmp = tempfile.mkstemp(dir=self.root, suffix=".tmp")
        os.close(fd)
        df.to_pickle(tmp)
        os.replace(tmp, self._path(key))
        rec = self.meta["stocks"].setdefault(key, {})
        rec.update(info)
        rec.update(first=df["timestamp"].iloc[0].date().isoformat(), last=df["timestamp"].iloc[-1].date().isoformat())

    def flush_meta(self) -> None:
        fd, tmp = tempfile.mkstemp(dir=self.root, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(self.meta, fh)
        os.replace(tmp, self._meta_path)

    def last_date(self, key: str) -> Optional[date]:
        s = (self.meta["stocks"].get(key) or {}).get("last")
        return date.fromisoformat(s) if s else None

    # ── updates ──
    def apply_bhav_rows(self, key: str, df: Optional[pd.DataFrame], rows: pd.DataFrame,
                        prev_session: dict[date, date]) -> tuple[Optional[pd.DataFrame], dict]:
        """
        Append bhavcopy rows (one per session, sorted) newer than the stored history.
        `prev_session` maps a session date to the session before it.
        Returns (frame, info) where info reports {'appended', 'adjusted', 'gap'}.
        """
        info = {"appended": 0, "adjusted": None, "gap": False}
        if df is None or df.empty:
            return df, info
        for r in rows.sort_values("date").itertuples(index=False):
            d = r.date.date()
            last = df["timestamp"].iloc[-1].date()
            if d <= last:
                continue
            if prev_session.get(d) != last:
                info["gap"] = True          # a session is missing: caller fills it from Dhan
                break
            pc, lc = r.prev_close, float(df["close"].iloc[-1])
            if pc and lc and abs(pc / lc - 1) > SPLIT_TOLERANCE:
                ratio = pc / lc
                df = adjust_for_corporate_action(df, ratio)
                info["adjusted"] = round(ratio, 4)
            df = pd.concat([df, pd.DataFrame([{
                "timestamp": pd.Timestamp(d), "open": r.open, "high": r.high, "low": r.low, "close": r.close,
                "volume": r.volume, "deliv_pct": r.deliv_pct,
            }])], ignore_index=True)
            info["appended"] += 1
        return df, info


async def fetch_dhan_daily(dhan, security_id: str, start: date, end: date, *, index: bool = False) -> Optional[pd.DataFrame]:
    if end < start:
        return None
    df = await dhan.get_historical_daily_data(
        security_id=str(security_id),
        exchange_segment="IDX_I" if index else "NSE_EQ",
        instrument="INDEX" if index else "EQUITY",
        from_date=start, to_date=end,
    )
    return normalize(df)


def previous_sessions(days: list[date]) -> dict[date, date]:
    """Map each date to the trading session before it (NSE calendar)."""
    from backend.services.market_calendar import is_trading_day

    out = {}
    for d in days:
        p = d - timedelta(days=1)
        for _ in range(15):
            if is_trading_day(p):
                break
            p -= timedelta(days=1)
        out[d] = p
    return out
