"""
IPO tracker: every main-board IPO listed on NSE since TRACK_SINCE (11 Nov 2021),
with its all-time high (ATH) worked out from Dhan daily candles since listing.
The start date is fixed: each refresh adds new listings (2027, 2028, ...) and
keeps every stock already tracked.

Sources
  * IPO list: NSE's "past issues" API (listing date, issue price, security
    type). Only securityType == "Equity" (main board) is kept; SME, REIT,
    InvIT and debt issues are dropped.
  * Prices: Dhan /charts/historical daily candles for the matched instrument.

Refresh is incremental: the first run loads each stock's full history once;
later runs only fetch candles after the last processed day and roll the ATH
forward. Everything is cached in data/cache/ipo_tracker.json.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Optional
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy.orm import Session

from backend.models.tables import Instrument

logger = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
TRACK_SINCE = date(2021, 11, 11)   # fixed start; the list only grows from here
NSE_CHUNK_DAYS = 365               # NSE past-issues requests are made one year at a time
AT_ATH = 0.98          # close >= 98% of ATH  -> "At ATH"
NEAR_ATH = 0.85        # close >= 85% of ATH  -> "Within 15% of ATH"

NSE_HOME = "https://www.nseindia.com/market-data/all-upcoming-issues-ipo"
NSE_PAST_ISSUES = "https://www.nseindia.com/api/public-past-issues"
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}

_cache: Optional[dict] = None
_lock = asyncio.Lock()
status: dict[str, Any] = {"running": False, "phase": "idle", "done": 0, "total": 0,
                          "started_at": None, "finished_at": None, "error": None, "summary": None}


def _cache_path() -> Path:
    from backend.config import DATA_DIR

    return DATA_DIR / "cache" / "ipo_tracker.json"


def _today() -> date:
    return datetime.now(IST).date()


def cutoff_date(today: Optional[date] = None) -> date:
    """Earliest listing date tracked. Fixed, so stocks never age out of the list."""
    return TRACK_SINCE


# ── cache ──

def load() -> dict:
    global _cache
    if _cache is None:
        path = _cache_path()
        data: dict = {}
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception as e:
                logger.warning("Ignoring unreadable IPO cache %s: %s", path, e)
        data.setdefault("ipos", [])
        _cache = data
    return _cache


def invalidate() -> None:
    global _cache
    _cache = None


def _save(data: dict) -> None:
    path = _cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    except Exception:
        Path(tmp).unlink(missing_ok=True)
        raise
    invalidate()


# ── NSE IPO list ──

def _parse_date(s: Any) -> Optional[date]:
    s = str(s or "").strip()
    for fmt in ("%d-%b-%Y", "%d-%m-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.title() if "%b" in fmt else s, fmt).date()
        except ValueError:
            continue
    return None


def _parse_price(s: Any) -> Optional[float]:
    """Issue price: "94", "Rs.94", "1,960". A range keeps its upper end."""
    nums = re.findall(r"\d+(?:\.\d+)?", str(s or "").replace(",", ""))
    return float(nums[-1]) if nums else None


_FPO = re.compile(r"\bFPO\b|follow[\s-]*on", re.I)
_PARTLY_PAID = re.compile(r"PP\d*$")


def parse_past_issues(rows: list[dict], today: Optional[date] = None) -> list[dict]:
    """Main-board equity IPOs listed since TRACK_SINCE, newest first, one per symbol."""
    since = cutoff_date(today)
    upto = today or _today()
    out: dict[str, dict] = {}
    for r in rows or []:
        if str(r.get("securityType") or "").strip().lower() != "equity":
            continue
        symbol = str(r.get("symbol") or "").strip().upper()
        company = str(r.get("companyName") or r.get("company") or "").strip()
        listed = _parse_date(r.get("listingDate"))
        if not symbol or not listed or not (since <= listed <= upto):
            continue
        if _FPO.search(company) or symbol.endswith("FPO"):
            continue  # follow-on offers of already-listed companies are not IPOs
        closed = _parse_date(r.get("ipoEndDate"))
        if _PARTLY_PAID.search(symbol) and (closed is None or (listed - closed).days > 30):
            continue  # partly-paid rights shares (e.g. OLAPP) of an already-listed company
        rec = {
            "symbol": symbol,
            "company": company,
            "listing_date": listed.isoformat(),
            "issue_price": _parse_price(r.get("issuePrice")),
        }
        prev = out.get(symbol)
        if prev is None or rec["listing_date"] > prev["listing_date"]:
            out[symbol] = rec
    return sorted(out.values(), key=lambda x: x["listing_date"], reverse=True)


def _windows(start: date, end: date, days: int = NSE_CHUNK_DAYS) -> list[tuple[date, date]]:
    """Split [start, end] into consecutive windows of at most `days` days."""
    out, lo = [], start
    while lo <= end:
        hi = min(end, lo + timedelta(days=days - 1))
        out.append((lo, hi))
        lo = hi + timedelta(days=1)
    return out


async def fetch_ipo_list(client: Optional[httpx.AsyncClient] = None, today: Optional[date] = None) -> list[dict]:
    """Download NSE's past-issues list (needs the site's cookies, so visit the IPO page first)."""
    t = today or _today()
    # Ask from a few months before the start: issues close before they list.
    # The range grows every year, so it is requested one year at a time.
    start = cutoff_date(t) - timedelta(days=120)
    own = client is None
    client = client or httpx.AsyncClient(timeout=30.0, headers=_HEADERS, follow_redirects=True)
    rows: list = []
    try:
        await client.get(NSE_HOME)
        for lo, hi in _windows(start, t):
            resp = await client.get(
                NSE_PAST_ISSUES,
                params={"from_date": lo.strftime("%d-%m-%Y"), "to_date": hi.strftime("%d-%m-%Y")},
                headers={"Referer": NSE_HOME, "Accept": "application/json"},
            )
            resp.raise_for_status()
            part = resp.json()
            if not isinstance(part, list):
                raise ValueError("unexpected response from NSE")
            rows.extend(part)
    finally:
        if own:
            await client.aclose()
    parsed = parse_past_issues(rows, t)
    if len(parsed) < 20:
        raise ValueError(f"NSE returned only {len(parsed)} main-board IPOs")
    return parsed


# ── Dhan matching ──

_NAME_NOISE = re.compile(r"\b(limited|ltd|the|india|co|company|corporation|corp)\b|[^a-z0-9]")


def _norm_name(s: str) -> str:
    return _NAME_NOISE.sub("", str(s or "").lower())


def match_instruments(db: Session, ipos: list[dict]) -> dict[str, Instrument]:
    """IPO symbol -> NSE equity instrument (by ticker, then by company name for renamed tickers)."""
    rows = db.query(Instrument).filter(Instrument.exchange == "NSE", Instrument.segment == "E").all()
    by_symbol = {str(r.trading_symbol or "").upper(): r for r in rows if r.trading_symbol}
    by_name: dict[str, Optional[Instrument]] = {}
    for r in rows:
        for key in {_norm_name(r.display_name), _norm_name(r.symbol)}:
            if len(key) >= 4:
                # An ambiguous name matches nothing (a wrong match is worse than none).
                by_name[key] = r if by_name.get(key, r) is r else None
    out = {}
    for ipo in ipos:
        inst = by_symbol.get(ipo["symbol"]) or by_name.get(_norm_name(ipo["company"]))
        if inst is not None:
            out[ipo["symbol"]] = inst
    return out


# ── ATH maths ──

def band(close: Optional[float], ath: Optional[float]) -> Optional[str]:
    if not close or not ath:
        return None
    r = close / ath
    return "at_ath" if r >= AT_ATH else "near" if r >= NEAR_ATH else "below"


def roll_forward(rec: dict, candles) -> dict:
    """
    Fold new daily candles (DataFrame: timestamp, open, high, low, close) into a
    record's running stats. Candles on/before rec["last_date"] are ignored.
    """
    if candles is None or len(candles) == 0:
        return rec
    last = rec.get("last_date")
    for row in candles.itertuples(index=False):
        d = row.timestamp.date() if hasattr(row.timestamp, "date") else _parse_date(row.timestamp)
        if d is None or (last and d.isoformat() <= last):
            continue
        hi, cl = float(row.high), float(row.close)
        if rec.get("listing_open") is None:
            rec["listing_open"] = round(float(row.open), 2)
            rec["first_candle"] = d.isoformat()
        if rec.get("ath") is None or hi > rec["ath"]:
            rec["ath"] = round(hi, 2)
            rec["ath_date"] = d.isoformat()
        rec["close"] = round(cl, 2)
        rec["last_date"] = last = d.isoformat()
    return rec


def derive(rec: dict) -> dict:
    """Percentages and band from the running stats."""
    close, ath = rec.get("close"), rec.get("ath")
    pct = lambda a, b: round((a / b - 1) * 100, 2) if a and b else None  # noqa: E731
    rec["from_ath_pct"] = pct(close, ath)
    rec["since_issue_pct"] = pct(close, rec.get("issue_price"))
    rec["listing_gain_pct"] = pct(rec.get("listing_open"), rec.get("issue_price"))
    rec["band"] = band(close, ath)
    return rec


# ── refresh ──

def _stat(**kw) -> None:
    status.update(kw)


async def refresh(db: Session, dhan=None, *, full: bool = False,
                  ipo_fetcher: Callable = fetch_ipo_list, today: Optional[date] = None) -> dict:
    """
    Update the IPO list from NSE and roll every stock's ATH forward from Dhan.
    `full=True` reloads each stock's history from its listing day.
    Only one refresh runs at a time.
    """
    if _lock.locked():
        return {"ok": False, "detail": "A refresh is already running"}
    async with _lock:
        t = today or _today()
        _stat(running=True, phase="list", done=0, total=0, error=None, summary=None,
              started_at=datetime.now(IST).isoformat(timespec="seconds"), finished_at=None)
        own_dhan = dhan is None
        try:
            current = load()
            old = {r["symbol"]: r for r in current.get("ipos", [])}
            list_error = None
            try:
                listed = await ipo_fetcher(today=t)
                list_fetched_at = datetime.now(IST).isoformat(timespec="seconds")
            except Exception as e:
                if not old:
                    raise RuntimeError(f"Could not download the IPO list from NSE: {e}") from e
                logger.warning("IPO list download failed, keeping the previous list: %s", e)
                list_error = str(e)[:200]
                listed = [{k: r[k] for k in ("symbol", "company", "listing_date", "issue_price")} for r in old.values()
                          if r["listing_date"] >= cutoff_date(t).isoformat()]
                list_fetched_at = current.get("list_fetched_at")

            # Never drop a stock already tracked, even if NSE's list stops returning it.
            known = {r["symbol"] for r in listed}
            since = cutoff_date(t).isoformat()
            listed += [{k: r.get(k) for k in ("symbol", "company", "listing_date", "issue_price")}
                       for r in old.values() if r["symbol"] not in known and r["listing_date"] >= since]
            listed.sort(key=lambda x: x["listing_date"], reverse=True)

            matched = match_instruments(db, listed)
            if dhan is None:
                from backend.services.dhan_client import DhanClient

                dhan = DhanClient()

            records = []
            _stat(phase="prices", total=len(listed))
            failed = 0
            for i, ipo in enumerate(listed):
                inst = matched.get(ipo["symbol"])
                prev = old.get(ipo["symbol"]) or {}
                rec = {**ipo}
                same_inst = inst is not None and prev.get("security_id") == str(inst.security_id)
                if same_inst and not full:
                    for k in ("listing_open", "first_candle", "ath", "ath_date", "close", "last_date"):
                        rec[k] = prev.get(k)
                if inst is not None:
                    rec.update(security_id=str(inst.security_id), dhan_symbol=inst.trading_symbol or inst.symbol,
                               display_name=inst.display_name, is_fno=bool(inst.is_fno),
                               lot_size=int(inst.lot_size) if inst.is_fno and inst.lot_size else None,
                               sector=inst.sector, in_dhan=True)
                    start = (date.fromisoformat(rec["last_date"]) + timedelta(days=1)) if rec.get("last_date") \
                        else date.fromisoformat(ipo["listing_date"])
                    if start <= t:
                        try:
                            candles = await dhan.get_historical_daily_data(
                                security_id=str(inst.security_id), exchange_segment="NSE_EQ",
                                instrument="EQUITY", from_date=start, to_date=t)
                            roll_forward(rec, candles)
                        except Exception as e:
                            failed += 1
                            logger.warning("IPO tracker: price history failed for %s: %s", ipo["symbol"], e)
                else:
                    rec.update(security_id=None, in_dhan=False, is_fno=False, lot_size=None)
                records.append(derive(rec))
                _stat(done=i + 1)

            payload = {
                "as_of": t.isoformat(),
                "list_fetched_at": list_fetched_at,
                "prices_updated_at": datetime.now(IST).isoformat(timespec="seconds"),
                "since": cutoff_date(t).isoformat(),
                "source": "NSE past issues (main board) + Dhan daily candles",
                "list_error": list_error,
                "ipos": records,
            }
            _save(payload)
            summary = {
                "ok": True, "ipos": len(records), "on_dhan": sum(1 for r in records if r["in_dhan"]),
                "price_failures": failed, "list_error": list_error,
                "at_ath": sum(1 for r in records if r.get("band") == "at_ath"),
                "near_ath": sum(1 for r in records if r.get("band") in ("at_ath", "near")),
            }
            _stat(summary=summary)
            return summary
        except Exception as e:
            logger.error("IPO tracker refresh failed: %s", e, exc_info=True)
            _stat(error=str(e)[:300])
            return {"ok": False, "detail": str(e)[:300]}
        finally:
            if own_dhan and dhan is not None:
                await dhan.close()
            _stat(running=False, phase="idle", finished_at=datetime.now(IST).isoformat(timespec="seconds"))
