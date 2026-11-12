"""
Free NSE data used by the swing engine (no login, no API key):

  * Daily bhavcopy with delivery % (sec_bhavdata_full_DDMMYYYY.csv): official OHLC,
    volume and delivery for every listed stock in ONE download per day. This keeps
    the candle store current without one Dhan call per stock.
  * Equity master list (EQUITY_L.csv): NSE symbol <-> ISIN and listing date.
  * Event calendar: upcoming board meetings / results (earnings gap risk).
  * ASM / GSM surveillance lists (stocks with extra margins and circuit limits).
  * Bulk and block deals (institutional footprints), accumulated day by day.

Everything is cached under data/swing/nse so a failed download never blocks a scan.
"""

from __future__ import annotations

import io
import json
import logging
import os
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Optional

import httpx
import pandas as pd

logger = logging.getLogger(__name__)

ARCHIVES = "https://nsearchives.nseindia.com"
WWW = "https://www.nseindia.com"
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/130.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "application/json, text/plain, */*",
}
SWING_SERIES = {"EQ"}   # BE = trade-to-trade (surveillance), SM/ST = SME: skipped for swing


def cache_dir() -> Path:
    from backend.config import DATA_DIR

    p = DATA_DIR / "swing" / "nse"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _write_json(path: Path, obj: Any) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, default=str)
    os.replace(tmp, path)


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _num(v: Any) -> Optional[float]:
    try:
        s = str(v).strip().replace(",", "")
        return None if s in ("", "-", "nan") else float(s)
    except (TypeError, ValueError):
        return None


# ── bhavcopy ──────────────────────────────────────────────────────────────

def parse_bhavcopy(text: str, expect: Optional[date] = None) -> pd.DataFrame:
    """
    Parse sec_bhavdata_full CSV into: symbol, series, date, prev_close, open, high, low,
    close, volume, turnover (INR), deliv_pct. Returns empty when the file is for another
    day (NSE serves the previous session's file for holidays).
    """
    df = pd.read_csv(io.StringIO(text), skipinitialspace=True, dtype=str)
    df.columns = [c.strip().upper() for c in df.columns]
    if df.empty or "SYMBOL" not in df.columns:
        return pd.DataFrame()
    out = pd.DataFrame({
        "symbol": df["SYMBOL"].str.strip(),
        "series": df["SERIES"].str.strip(),
        "date": pd.to_datetime(df["DATE1"].str.strip(), format="%d-%b-%Y", errors="coerce"),
    })
    for src, dst in (("PREV_CLOSE", "prev_close"), ("OPEN_PRICE", "open"), ("HIGH_PRICE", "high"),
                     ("LOW_PRICE", "low"), ("CLOSE_PRICE", "close"), ("TTL_TRD_QNTY", "volume"),
                     ("TURNOVER_LACS", "turnover"), ("DELIV_PER", "deliv_pct")):
        out[dst] = df[src].map(_num) if src in df.columns else None
    out["turnover"] = out["turnover"] * 1e5
    out = out.dropna(subset=["date", "open", "high", "low", "close"])
    if expect is not None:
        out = out[out["date"].dt.date == expect]
    return out.reset_index(drop=True)


async def fetch_bhavcopy(d: date, client: Optional[httpx.AsyncClient] = None) -> pd.DataFrame:
    """One day's bhavcopy (cached on disk once downloaded). Empty if not published / holiday."""
    path = cache_dir() / f"bhav_{d:%Y%m%d}.csv"
    if path.is_file():
        return parse_bhavcopy(path.read_text(encoding="utf-8"), d)
    url = f"{ARCHIVES}/products/content/sec_bhavdata_full_{d:%d%m%Y}.csv"
    own = client is None
    client = client or httpx.AsyncClient(headers=_HEADERS, timeout=30, follow_redirects=True)
    try:
        r = await client.get(url)
        if r.status_code != 200 or "SYMBOL" not in r.text[:200]:
            return pd.DataFrame()
        df = parse_bhavcopy(r.text, d)
        if not df.empty:
            path.write_text(r.text, encoding="utf-8")
        return df
    except Exception as e:
        logger.warning("Bhavcopy %s download failed: %s", d, e)
        return pd.DataFrame()
    finally:
        if own:
            await client.aclose()


def prune_bhav_cache(keep_days: int = 120) -> None:
    cutoff = date.today() - timedelta(days=keep_days)
    for p in cache_dir().glob("bhav_*.csv"):
        try:
            if datetime.strptime(p.stem[5:], "%Y%m%d").date() < cutoff:
                p.unlink()
        except (ValueError, OSError):
            continue


# ── equity master (symbol <-> ISIN, listing date) ───────────────────────────

def parse_equity_list(text: str) -> dict[str, dict]:
    df = pd.read_csv(io.StringIO(text), skipinitialspace=True, dtype=str)
    df.columns = [c.strip().upper() for c in df.columns]
    out = {}
    for row in df.itertuples(index=False):
        rec = dict(zip(df.columns, row))
        sym = str(rec.get("SYMBOL") or "").strip()
        isin = str(rec.get("ISIN NUMBER") or "").strip()
        if not sym:
            continue
        listed = pd.to_datetime(str(rec.get("DATE OF LISTING") or "").strip(), format="%d-%b-%Y", errors="coerce")
        out[sym] = {"isin": isin, "series": str(rec.get("SERIES") or "").strip(),
                    "listed": listed.date().isoformat() if pd.notna(listed) else None,
                    "name": str(rec.get("NAME OF COMPANY") or "").strip()}
    return out


async def equity_master(max_age_days: int = 7) -> dict[str, dict]:
    path = cache_dir() / "equity_list.json"
    cached = _read_json(path)
    if cached and cached.get("fetched") and \
            (date.today() - date.fromisoformat(cached["fetched"])).days < max_age_days:
        return cached["data"]
    try:
        async with httpx.AsyncClient(headers=_HEADERS, timeout=30, follow_redirects=True) as c:
            r = await c.get(f"{ARCHIVES}/content/equities/EQUITY_L.csv")
            r.raise_for_status()
        data = parse_equity_list(r.text)
        if data:
            _write_json(path, {"fetched": date.today().isoformat(), "data": data})
            return data
    except Exception as e:
        logger.warning("NSE equity list download failed: %s", e)
    return (cached or {}).get("data") or {}


# ── www.nseindia.com JSON APIs (need the home-page cookie first) ────────────

async def _nse_json(paths: list[str], referer: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    async with httpx.AsyncClient(headers=_HEADERS, timeout=25, follow_redirects=True) as c:
        try:
            await c.get(f"{WWW}{referer}")
        except Exception as e:
            logger.warning("NSE cookie request failed: %s", e)
            return out
        for p in paths:
            try:
                r = await c.get(f"{WWW}{p}")
                if r.status_code == 200:
                    out[p] = r.json()
            except Exception as e:
                logger.warning("NSE %s failed: %s", p, e)
    return out


def parse_events(rows: Any) -> dict[str, list[dict]]:
    """Event calendar -> {symbol: [{date, purpose}]} (results and board meetings)."""
    out: dict[str, list[dict]] = {}
    for r in rows if isinstance(rows, list) else []:
        try:
            d = datetime.strptime(str(r.get("date")).strip(), "%d-%b-%Y").date()
        except ValueError:
            continue
        sym = str(r.get("symbol") or "").strip()
        if sym:
            out.setdefault(sym, []).append({"date": d.isoformat(), "purpose": str(r.get("purpose") or "").strip()})
    return out


_ROMAN = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6}


def _stage(text: Any) -> Optional[int]:
    """'Stage II' / 'LTASM - II (14)' -> 2."""
    import re

    m = re.search(r"(?:Stage|ASM)\s*-?\s*([IV]+)\b", str(text or ""))
    return _ROMAN.get(m.group(1)) if m else None


def parse_surveillance(asm: Any, gsm: Any) -> dict[str, dict]:
    """{symbol: {'kind': 'ASM-LT'|'ASM-ST'|'GSM', 'stage': int|None, 'desc': str}}; GSM wins over ASM."""
    out: dict[str, dict] = {}
    if isinstance(asm, dict):
        for key, kind in (("longterm", "ASM-LT"), ("shortterm", "ASM-ST")):
            for r in ((asm.get(key) or {}).get("data") or []):
                sym = str(r.get("symbol") or "").strip()
                if not sym:
                    continue
                rec = {"kind": kind, "stage": _stage(r.get("asmSurvIndicator")) or _stage(r.get("survCode")),
                       "desc": str(r.get("survDesc") or r.get("survCode") or kind)[:80]}
                prev = out.get(sym)
                # a stock on both ASM lists keeps the stricter entry (short-term, or the higher stage)
                if prev is None or (rec["kind"] == "ASM-ST") or (rec["stage"] or 0) > (prev["stage"] or 0):
                    out[sym] = rec
    for r in gsm if isinstance(gsm, list) else []:
        sym = str(r.get("symbol") or "").strip()
        if sym:
            out[sym] = {"kind": "GSM", "stage": None, "desc": str(r.get("survDesc") or "GSM")[:80]}
    return out


def surveillance_info(intel: dict, symbol: str) -> Optional[dict]:
    """Normalised surveillance entry for a symbol (older caches stored a plain description string)."""
    v = (intel.get("surveillance") or {}).get(symbol)
    if v is None:
        return None
    if isinstance(v, str):
        kind = "GSM" if "GSM" in v.upper() else ("ASM-ST" if "short" in v.lower() else "ASM-LT")
        return {"kind": kind, "stage": _stage(v), "desc": v}
    return v


def surveillance_tradeable(info: Optional[dict]) -> bool:
    """Only long-term ASM Stage I (100% margin, normal price band) stays tradeable for swing."""
    return info is None or (info.get("kind") == "ASM-LT" and info.get("stage") == 1)


def surveillance_label(info: dict) -> str:
    stage = f" Stage {info['stage']}" if info.get("stage") else ""
    return {"ASM-LT": "long-term ASM", "ASM-ST": "short-term ASM", "GSM": "GSM"}.get(info.get("kind"), "surveillance") + stage


def merge_deals(old: dict, payload: Any, keep_days: int = 60) -> dict:
    """Accumulate bulk/block deals by symbol (NSE only shows the latest session)."""
    deals = dict(old or {})
    if isinstance(payload, dict):
        for kind, key in (("bulk", "BULK_DEALS_DATA"), ("block", "BLOCK_DEALS_DATA")):
            for r in payload.get(key) or []:
                sym = str(r.get("symbol") or "").strip()
                try:
                    d = datetime.strptime(str(r.get("date")).strip(), "%d-%b-%Y").date().isoformat()
                except ValueError:
                    continue
                rec = {"date": d, "kind": kind, "side": str(r.get("buySell") or "").upper(),
                       "client": str(r.get("clientName") or "")[:60], "qty": _num(r.get("qty")),
                       "price": _num(r.get("watp"))}
                lst = deals.setdefault(sym, [])
                if rec not in lst:
                    lst.append(rec)
    cutoff = (date.today() - timedelta(days=keep_days)).isoformat()
    return {s: [x for x in v if x["date"] >= cutoff] for s, v in deals.items() if any(x["date"] >= cutoff for x in v)}


async def refresh_market_intel() -> dict:
    """Download events, surveillance lists and deals (once a day); returns the cached bundle."""
    path = cache_dir() / "intel.json"
    old = _read_json(path) or {}
    if old.get("fetched") == date.today().isoformat() and old.get("events"):
        return old
    got = await _nse_json(
        ["/api/event-calendar", "/api/reportASM", "/api/reportGSM", "/api/snapshot-capital-market-largedeal"],
        "/companies-listing/corporate-filings-event-calendar",
    )
    bundle = {
        "fetched": date.today().isoformat(),
        "events": parse_events(got.get("/api/event-calendar")) or old.get("events") or {},
        "surveillance": (parse_surveillance(got.get("/api/reportASM"), got.get("/api/reportGSM"))
                         or old.get("surveillance") or {}),
        "deals": merge_deals(old.get("deals") or {}, got.get("/api/snapshot-capital-market-largedeal")),
        "errors": [p for p in ("/api/event-calendar", "/api/reportASM", "/api/reportGSM") if p not in got],
    }
    _write_json(path, bundle)
    return bundle


def load_market_intel() -> dict:
    return _read_json(cache_dir() / "intel.json") or {"events": {}, "surveillance": {}, "deals": {}}


def next_event(intel: dict, symbol: str, today: date, horizon_days: int = 21) -> Optional[dict]:
    for ev in sorted((intel.get("events") or {}).get(symbol, []), key=lambda e: e["date"]):
        d = date.fromisoformat(ev["date"])
        if today <= d <= today + timedelta(days=horizon_days):
            return {**ev, "days": (d - today).days}
    return None


def institutional_deals(intel: dict, symbol: str) -> dict:
    """Net bulk/block buying in the deal history: {'buy_qty', 'sell_qty', 'count', 'last'}."""
    rows = (intel.get("deals") or {}).get(symbol) or []
    buy = sum(r["qty"] or 0 for r in rows if r["side"] == "BUY")
    sell = sum(r["qty"] or 0 for r in rows if r["side"] == "SELL")
    return {"buy_qty": buy, "sell_qty": sell, "count": len(rows),
            "last": max((r["date"] for r in rows), default=None),
            "clients": sorted({r["client"] for r in rows if r["side"] == "BUY"})[:3]}
