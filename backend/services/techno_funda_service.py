"""
TechnoFunda Analysis — orchestration.

  search(q)        local instrument master first, Tapetide search for names/brands/renames
  analyze(symbol)  fetch everything in parallel, run the technical + fundamental engines,
                   combine into one verdict. Cached in memory for `cache_minutes`.

Data sources (no accounts or keys needed beyond what the app already has):
  Fundamentals, cached on disk (data/techno_funda_cache) for `fundamentals_cache_hours`:
  * Screener.in public page — statements, ratios, shareholding, profile (free, no login)
  * Tickertape              — promoter pledge, scorecard, shareholding fallback (free)
  * Tapetide MCP extras     — analyst forecasts, concall digest, news (1 call each; free plan is
                              50 calls/day shared with Value Investing); Tapetide core statements
                              only when Screener fails
  Prices: Dhan (2Y daily + NIFTY 50) → Yahoo Finance chart (free) → Tapetide (~6 months)
"""

from __future__ import annotations

import asyncio
import re
import logging
import time
from datetime import date, datetime, timedelta
from typing import Any, Optional

import pandas as pd
from sqlalchemy.orm import Session

import json

from backend.config import DATA_DIR, get_config
from backend.models.tables import Instrument
from backend.services.tapetide_mcp_client import TapetideMcpClient
from backend.services.techno_funda_fundamental import analyze_fundamentals
from backend.services.techno_funda_business import build_business
from backend.services.techno_funda_sources import (
    ScreenerSource, TickertapeSource, WikipediaSource, YahooPrices, fetch_markdown, fetch_screener_peers,
    split_markdown_sections,
)
from backend.services.techno_funda_technical import analyze_technicals

logger = logging.getLogger(__name__)

DISCLAIMER = (
    "This report is generated automatically from public market data for education and research. "
    "It is not investment advice or a recommendation to buy, sell or hold any security, and it is not "
    "issued by a SEBI-registered research analyst or investment adviser. Data can be delayed or wrong; "
    "verify with the company's filings and consult a qualified adviser before investing."
)

_CACHE: dict[str, tuple[float, dict]] = {}

# Tapetide free plan = 50 tool calls per day (resets at midnight IST), shared with the Value
# Investing tab. One analysis costs CORE (5) + chosen EXTRAS; results are cached on disk.
# Only used when Screener fails.
_CORE_CALLS: dict[str, tuple[str, dict]] = {
    "profile": ("get_company_profile", {}),
    # No `section` = all five statements in one call; periods/quarters widen the history.
    "financials": ("get_financials", {"periods": 12, "quarters": 13}),
    "shareholding": ("get_shareholding", {}),
    "pledge": ("get_promoter_pledge", {}),
}
# What only Tapetide offers for free; `techno_funda.tapetide_extras` picks which to spend calls on.
_EXTRA_CALLS: dict[str, tuple[str, dict]] = {
    "forecasts": ("get_forecasts", {}),
    "concall": ("get_earnings_call_summary", {"limit": 1}),
    "news": ("get_stock_events", {"type": "news", "limit": 8}),
    "deals": ("get_stock_deals", {"limit": 10}),
    "score": ("get_tapetide_score", {}),
    "corporate_actions": ("get_stock_events", {"type": "corporate_actions", "limit": 8}),
    "credit": ("get_credit_ratings", {}),
    "options": ("get_options_analytics", {}),
}
# "annual_report" is handled separately (list call + free download of the digest), not via _fetch_tapetide.
_DEFAULT_EXTRAS = ["forecasts", "concall", "news", "annual_report"]
_SPECIAL_EXTRAS = {"annual_report"}
_SECTIONS = ("quarterly", "profit_loss", "balance_sheet", "cash_flow", "ratios")
TAPETIDE_DAILY_LIMIT = 50
_CACHE_DIR = DATA_DIR / "techno_funda_cache"


def _ist_today() -> str:
    return (datetime.utcnow() + timedelta(hours=5, minutes=30)).strftime("%Y-%m-%d")


class TapetideBudget:
    """Counts this tab's Tapetide calls per IST day and remembers when the quota is exhausted."""

    path = _CACHE_DIR / "_quota.json"

    @classmethod
    def _load(cls) -> dict:
        try:
            d = json.loads(cls.path.read_text(encoding="utf-8"))
            if d.get("date") == _ist_today():
                return d
        except Exception:
            pass
        return {"date": _ist_today(), "calls": 0, "exhausted": False}

    @classmethod
    def _save(cls, d: dict) -> None:
        try:
            _CACHE_DIR.mkdir(parents=True, exist_ok=True)
            cls.path.write_text(json.dumps(d), encoding="utf-8")
        except Exception as e:  # pragma: no cover
            logger.debug("Could not save Tapetide quota state: %s", e)

    @classmethod
    def status(cls) -> dict:
        d = cls._load()
        return {"date_ist": d["date"], "calls_by_this_tab": d["calls"], "daily_limit": TAPETIDE_DAILY_LIMIT,
                "exhausted": d["exhausted"]}

    @classmethod
    def record(cls, n: int = 1, exhausted: bool = False) -> None:
        d = cls._load()
        d["calls"] += n
        d["exhausted"] = d["exhausted"] or exhausted
        cls._save(d)

    @staticmethod
    def is_quota_error(msg: str) -> bool:
        m = (msg or "").lower()
        return "tool calls for today" in m or ("free" in m and "limit resets" in m)


def _disk_cache_read(symbol: str) -> Optional[dict]:
    try:
        return json.loads((_CACHE_DIR / f"{symbol}.json").read_text(encoding="utf-8"))
    except Exception:
        return None


def _disk_cache_write(symbol: str, payload: dict) -> None:
    try:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (_CACHE_DIR / f"{symbol}.json").write_text(json.dumps(payload, default=str), encoding="utf-8")
    except Exception as e:
        logger.info("TechnoFunda cache write failed for %s: %s", symbol, e)


def _is_isin(s: Optional[str]) -> bool:
    return bool(s) and bool(re.fullmatch(r"IN[A-Z0-9]{10}", s))


def _split_financials(resp: Any) -> dict[str, Any]:
    """`get_financials` without a section returns one block per statement; key them by section."""
    out: dict[str, Any] = {}
    data = resp.get("data") if isinstance(resp, dict) else None
    blocks = data if isinstance(data, list) else ([data] if isinstance(data, dict) else [])
    for b in blocks:
        if isinstance(b, dict) and b.get("section") in _SECTIONS:
            out[b["section"]] = {"data": [b]}
    if not out and isinstance(data, dict):  # alternate shape: {"quarterly": {...}, ...}
        for sec in _SECTIONS:
            if isinstance(data.get(sec), dict):
                out[sec] = {"data": [data[sec]]}
    return out


def _cfg() -> dict:
    return get_config().get("techno_funda") or {}


class TechnoFundaService:
    def __init__(self, db: Session):
        self.db = db
        cfg = _cfg()
        self.cache_minutes = float(cfg.get("cache_minutes", 15))
        self.history_days = int(cfg.get("history_days", 730))
        self.gsec_yield = float(cfg.get("gsec_10y_yield", 6.5))
        self.weights = cfg.get("verdict_weights") or {"fundamental": 0.55, "technical": 0.45}
        self.concurrency = int(cfg.get("tapetide_concurrency", 6))
        self.fund_cache_hours = float(cfg.get("fundamentals_cache_hours", 24))
        extras = cfg.get("tapetide_extras")
        self.extras = [e for e in (extras if isinstance(extras, list) else _DEFAULT_EXTRAS)
                       if e in _EXTRA_CALLS or e in _SPECIAL_EXTRAS]

    # ───────────────────────── search ─────────────────────────

    async def search(self, q: str, limit: int = 12, deep: bool = False) -> list[dict]:
        """Local instrument master (free). `deep` adds Tapetide search (1 quota call) for brand
        names, renames and BSE-only companies — the UI asks for it only when local finds nothing."""
        q = (q or "").strip()
        if len(q) < 1:
            return []
        qu = q.upper()
        like = f"%{qu}%"
        rows = (
            self.db.query(Instrument)
            .filter(Instrument.exchange == "NSE", Instrument.segment == "E", Instrument.instrument_type == "ES")
            .filter((Instrument.symbol.like(like)) | (Instrument.display_name.like(like)) | (Instrument.trading_symbol.like(like)))
            .limit(80)
            .all()
        )

        def rank(i: Instrument) -> tuple:
            sym = (i.trading_symbol or "").upper()
            name = (i.display_name or i.symbol or "").upper()
            return (sym != qu, not (sym.startswith(qu) or name.startswith(qu)), not sym, len(sym or name))

        out: list[dict] = []
        seen: set[str] = set()
        for i in sorted(rows, key=rank):
            # trading_symbol is the NSE ticker; rows from an older instrument refresh lack it, so
            # those are analysed by ISIN (resolved to a ticker once, then cached).
            sym = (i.trading_symbol or "").upper() or None
            key = sym or (i.isin or "").upper()
            if not key or key in seen:
                continue
            seen.add(key)
            out.append({"symbol": sym, "key": key, "isin": i.isin, "name": i.display_name or i.symbol, "exchange": "NSE",
                        "sector": i.sector, "is_fno": bool(i.is_fno), "source": "local",
                        "cached": (_CACHE_DIR / f"{key}.json").exists()})
            if len(out) >= limit:
                break

        if deep and len(q) >= 2 and not TapetideBudget.status()["exhausted"]:
            client = TapetideMcpClient()
            try:
                res = await asyncio.wait_for(client.call_tool("search_stocks", {"query": q, "limit": 8}), timeout=10)
                TapetideBudget.record(1)
                for r in res.get("data") or []:
                    sym = (r.get("nse_symbol") or r.get("symbol") or "").upper()
                    if not sym or sym in seen or not r.get("is_active", True):
                        continue
                    seen.add(sym)
                    out.append({"symbol": sym, "key": sym, "isin": None, "name": r.get("name") or sym,
                                "exchange": "NSE" if r.get("nse_symbol") else "BSE",
                                "sector": r.get("industry") or r.get("sector"), "is_fno": None, "source": "tapetide",
                                "cached": (_CACHE_DIR / f"{sym}.json").exists()})
            except Exception as e:
                TapetideBudget.record(0, exhausted=TapetideBudget.is_quota_error(str(e)))
                logger.info("Tapetide search unavailable for %r: %s", q, e)
            finally:
                await client.close()
        return out[: limit + 8]

    # ───────────────────────── analysis ─────────────────────────

    async def analyze(self, symbol: str, refresh: bool = False, refresh_fundamentals: bool = False) -> dict:
        """refresh: rebuild the report with fresh candles. refresh_fundamentals: also bypass the
        fundamentals disk cache (spends Tapetide quota)."""
        symbol = (symbol or "").strip().upper()
        if not symbol:
            raise ValueError("Symbol is required")
        cached = _CACHE.get(symbol)
        if cached and not (refresh or refresh_fundamentals) and time.time() - cached[0] < self.cache_minutes * 60:
            return {**cached[1], "cached": True, "quota": TapetideBudget.status()}

        started = time.time()
        instrument = self._resolve_instrument(symbol)
        raw, fmeta = await self._get_fundamentals(symbol, instrument, force=refresh_fundamentals)
        tt_symbol = fmeta.get("tapetide_symbol") or symbol

        bse_code = (((raw.get("profile") or {}).get("data") or {}).get("company") or {}).get("bse_code")
        prices, bench, price_source, price_note = await self._fetch_prices(instrument, tt_symbol, bse_code)

        from backend.services.value_investing_service import ValueInvestingService  # reuse fair-value / DCF math
        fundamental = analyze_fundamentals(raw, valuation_helper=ValueInvestingService(self.db),
                                           gsec_yield=self.gsec_yield, prices=prices)
        if not fundamental.get("available") and fmeta.get("message"):
            fundamental["reason"] = fmeta["message"]
        technical = analyze_technicals(prices, bench)
        business = build_business(raw, fundamental) if fundamental.get("available") else {"available": False}

        if not fundamental.get("available") and not technical.get("available"):
            raise LookupError(fmeta.get("message") or f"No data found for '{symbol}'. Check the NSE symbol and try again.")

        verdict = self._verdict(fundamental, technical)
        company = fundamental.get("company") or {}
        valuation = fundamental.get("valuation") or {}
        live_px = technical.get("last_close") if str(price_source).startswith(("Dhan", "Yahoo")) else None
        display_symbol = tt_symbol if _is_isin(symbol) and not _is_isin(tt_symbol) else symbol
        result = {
            "symbol": display_symbol,
            "request_key": symbol,
            "tapetide_symbol": tt_symbol,
            "name": company.get("name") or (instrument.display_name if instrument else symbol),
            "exchange": "NSE",
            "security_id": instrument.security_id if instrument else None,
            "isin": company.get("isin") or (instrument.isin if instrument else None),
            "sector": company.get("sector") or (instrument.sector if instrument else None),
            "industry": company.get("industry"),
            "price": live_px or valuation.get("price") or technical.get("last_close"),
            "quote": ((raw.get("profile") or {}).get("data") or {}).get("quote"),
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "elapsed_sec": round(time.time() - started, 1),
            "verdict": verdict,
            "fundamental": fundamental,
            "business": business,
            "technical": technical,
            "sources": {
                "prices": price_source,
                "price_note": price_note,
                "fundamentals": _sources_summary(fmeta.get("sections") or {}),
                "fundamentals_meta": fmeta,
            },
            "quota": TapetideBudget.status(),
            "disclaimer": DISCLAIMER,
            "cached": False,
        }
        _CACHE[symbol] = (time.time(), result)
        return result

    # ───────────────────────── fetchers ─────────────────────────

    def _resolve_instrument(self, symbol: str) -> Optional[Instrument]:
        base = self.db.query(Instrument).filter(Instrument.exchange == "NSE", Instrument.segment == "E")
        if _is_isin(symbol):
            return base.filter(Instrument.isin == symbol).first()
        return base.filter(Instrument.trading_symbol == symbol).first() or base.filter(Instrument.symbol == symbol).first()

    async def _get_fundamentals(self, symbol: str, instrument: Optional[Instrument], force: bool) -> tuple[dict, dict]:
        """Source chain, cached on disk for `fundamentals_cache_hours`:
             Screener (statements, ratios, shareholding, profile)  — free, 1-2 page loads
             Tickertape (pledge, scorecard; shareholding fallback) — free
             Tapetide extras (forecasts, concall, news)           — 1 quota call each
             Tapetide core (profile + statements)                 — only if Screener fails
        """
        disk = _disk_cache_read(symbol)
        age_h = None
        if disk and disk.get("fetched_at"):
            try:
                age_h = (datetime.now() - datetime.fromisoformat(disk["fetched_at"])).total_seconds() / 3600
            except ValueError:
                age_h = None

        def meta(source: str, **kw) -> dict:
            base = {"source": source, "fetched_at": (disk or {}).get("fetched_at"),
                    "age_hours": round(age_h, 1) if age_h is not None else None,
                    "tapetide_symbol": (disk or {}).get("tapetide_symbol"),
                    "sections": (disk or {}).get("sections") or {}, "calls_used": 0, "errors": {}, "message": None}
            base.update(kw)
            return base

        if disk and not force and age_h is not None and age_h < self.fund_cache_hours:
            raw = disk.get("raw") or {}
            if not raw.get("_business_fetched"):
                ticker_c = disk.get("tapetide_symbol") or symbol
                if not (((raw.get("profile") or {}).get("data") or {}).get("screener_ids")):
                    try:  # saved before Screener ids/key points were captured: refresh that page (free)
                        raw.update(await ScreenerSource().fetch(ticker_c))
                    except Exception as e:
                        logger.info("Screener refresh for business backfill failed for %s: %s", ticker_c, e)
                upd, b_calls = await self._fetch_business(raw, ticker_c)
                raw.update(upd)
                disk["raw"] = raw
                disk.setdefault("sections", {}).update({k: _BUSINESS_SOURCES[k] for k in upd if k in _BUSINESS_SOURCES})
                _disk_cache_write(symbol, disk)
                return raw, meta("cache", calls_used=b_calls, sections=disk["sections"])
            return raw, meta("cache")

        ticker = (disk or {}).get("tapetide_symbol") or (instrument.trading_symbol if instrument is not None else None) or symbol
        calls = 0
        if _is_isin(ticker):
            resolved = await self._resolve_isin(ticker)
            calls += resolved[1]
            if not resolved[0]:
                if disk:
                    return disk.get("raw") or {}, meta("stale-cache", message="Could not refresh: ticker lookup failed.")
                return {}, meta("none", calls_used=calls, message=(
                    f"Could not map ISIN {symbol} to an NSE ticker. Settings → Refresh instruments fills tickers in, "
                    "or search by the ticker directly."))
            ticker = resolved[0]

        is_fno = bool(instrument.is_fno) if instrument is not None else False
        quota_out = TapetideBudget.status()["exhausted"]
        extras = {k: _EXTRA_CALLS[k] for k in self.extras
                  if k in _EXTRA_CALLS and not (k == "options" and not is_fno)}

        async def run(coro):
            try:
                return await coro, None
            except Exception as e:  # each source may fail independently
                return None, f"{type(e).__name__}: {e}"[:240]

        tasks = [run(ScreenerSource().fetch(ticker)), run(TickertapeSource().fetch(ticker))]
        if extras and not quota_out:
            tasks.append(run(self._fetch_tapetide(ticker, extras)))
        results = await asyncio.gather(*tasks)
        (scr, scr_err), (ttp, ttp_err) = results[0], results[1]

        raw: dict[str, Any] = {}
        sections: dict[str, str] = {}
        errors: dict[str, str] = {}
        quota_hit = False
        if scr:
            raw.update(scr)
            sections.update({k: "screener" for k in scr})
        else:
            errors["screener"] = scr_err or "no data"
        if ttp:
            for k in ("pledge", "scorecard"):
                if ttp.get(k):
                    raw[k] = ttp[k]
                    sections[k] = "tickertape"
            if not raw.get("shareholding") and ttp.get("shareholding"):
                raw["shareholding"] = ttp["shareholding"]
                sections["shareholding"] = "tickertape"
        else:
            errors["tickertape"] = ttp_err or "no data"
        if len(results) > 2:
            tp, tp_err = results[2]
            if tp:
                t_raw, t_err, t_calls, t_quota = tp
                calls += t_calls
                quota_hit = quota_hit or t_quota
                for k, v in t_raw.items():
                    if v:
                        raw[k] = v
                        sections[k] = "tapetide"
                errors.update({f"tapetide.{k}": v for k, v in t_err.items()})
            else:
                errors["tapetide"] = tp_err or "failed"

        # Screener failed → Tapetide core statements (quota permitting)
        if not scr and not quota_hit and not TapetideBudget.status()["exhausted"]:
            res, err = await run(self._fetch_tapetide(ticker, _CORE_CALLS))
            if res:
                t_raw, t_err, t_calls, t_quota = res
                calls += t_calls
                quota_hit = quota_hit or t_quota
                for k, v in t_raw.items():
                    if v and not raw.get(k):
                        raw[k] = v
                        sections[k] = "tapetide"
                errors.update({f"tapetide.{k}": v for k, v in t_err.items()})

        # Business profile: peers + Wikipedia (free) and the annual-report digest (1 Tapetide call)
        if raw.get("profile"):
            upd, b_calls = await self._fetch_business(raw, ticker)
            calls += b_calls
            raw.update(upd)
            sections.update({k: _BUSINESS_SOURCES[k] for k in upd if k in _BUSINESS_SOURCES})

        if disk:  # keep earlier data for any section that failed this time
            for k, v in (disk.get("raw") or {}).items():
                if not raw.get(k) and v:
                    raw[k] = v
                    sections[k] = f"{(disk.get('sections') or {}).get(k, 'tapetide').split(' ')[0]} (saved)"

        message = None
        if quota_out or quota_hit:
            message = ("Tapetide's free daily limit is used up, so analyst forecasts, concall digest and news "
                       "are missing or from an earlier fetch. Everything else comes from free sources.")
        if raw.get("profile") or raw.get("profit_loss"):
            _disk_cache_write(symbol, {"fetched_at": datetime.now().isoformat(timespec="seconds"),
                                       "tapetide_symbol": ticker, "sections": sections, "raw": raw})
            source = "live"
        else:
            source = "none"
            message = f"No fundamentals found for '{ticker}' on Screener, Tickertape or Tapetide."
        if errors:
            logger.info("TechnoFunda %s source errors: %s", ticker, errors)
        return raw, {"source": source, "fetched_at": datetime.now().isoformat(timespec="seconds"), "age_hours": 0,
                     "tapetide_symbol": ticker, "sections": sections, "calls_used": calls,
                     "errors": errors, "message": message}

    async def _fetch_business(self, raw: dict, ticker: str) -> tuple[dict, int]:
        """Peers + Wikipedia (free) and the annual-report digest (1 Tapetide call), in parallel."""
        prof = ((raw.get("profile") or {}).get("data")) or {}
        company = prof.get("company") or {}
        ids = prof.get("screener_ids") or {}
        name = company.get("name") or ticker

        async def safe(coro, label):
            try:
                return await coro
            except Exception as e:
                logger.info("TechnoFunda %s %s unavailable: %s", ticker, label, e)
                return None

        jobs = {
            "peers": safe(fetch_screener_peers(ids["warehouse"]), "peers") if ids.get("warehouse") else None,
            "wiki": safe(WikipediaSource().profile(name, ticker), "wikipedia"),
            "annual_report": (safe(self._fetch_annual_report(ticker), "annual report")
                              if "annual_report" in self.extras and not TapetideBudget.status()["exhausted"] else None),
        }
        jobs = {k: v for k, v in jobs.items() if v is not None}
        results = dict(zip(jobs, await asyncio.gather(*jobs.values())))
        calls = 0
        out: dict[str, Any] = {"_business_fetched": True}
        for k, v in results.items():
            if k == "annual_report" and v:
                v, n = v
                calls += n
            if v:
                out[k] = v
        return out, calls

    async def _fetch_annual_report(self, symbol: str) -> Optional[tuple[dict, int]]:
        """Latest annual report with a parsed digest. One list call; the digest itself is a public
        Markdown file. Falls back to get_document_summary (1 more call) if no download link."""
        client = TapetideMcpClient()
        calls = 0
        try:
            try:
                res = await asyncio.wait_for(client.call_tool(
                    "list_company_documents", {"symbol": symbol, "doc_types": ["annual_report"], "limit": 3}), timeout=25)
                calls += 1
                TapetideBudget.record(1)
            except Exception as e:
                TapetideBudget.record(0, exhausted=TapetideBudget.is_quota_error(str(e)))
                raise
            data = res.get("data") or {}
            docs = data.get("documents") if isinstance(data, dict) else data
            doc = next((d for d in docs or [] if d.get("doc_id") and d.get("has_summary")), None)
            if not doc:
                return None
            md = None
            url = (doc.get("links") or {}).get("summary_url")
            if url:
                try:
                    md = await fetch_markdown(url)
                except Exception as e:
                    logger.info("Annual report digest download failed for %s: %s", symbol, e)
            if not md and not TapetideBudget.status()["exhausted"]:
                s = await asyncio.wait_for(client.call_tool(
                    "get_document_summary", {"symbol": symbol, "doc_id": doc["doc_id"]}), timeout=25)
                calls += 1
                TapetideBudget.record(1)
                md = ((s.get("data") or {}) if isinstance(s.get("data"), dict) else {}).get("summary")
            sections = split_markdown_sections(md or "")
            if not sections:
                return None
            return ({"period": doc.get("period"), "title": doc.get("title"), "date": doc.get("doc_date"),
                     "pages": doc.get("num_pages"), "pdf_url": doc.get("source_url"), "sections": sections,
                     "source": "Tapetide AI digest of the company's annual report"}, calls)
        finally:
            await client.close()

    async def _resolve_isin(self, isin: str) -> tuple[Optional[str], int]:
        """ISIN → NSE ticker: Yahoo search, then Tickertape (both free), Tapetide search last (1 call)."""
        try:
            t = await YahooPrices().isin_to_ticker(isin)
            if t:
                return t, 0
        except Exception as e:
            logger.info("Yahoo ISIN lookup failed for %s: %s", isin, e)

        def tickertape(isin_: str) -> Optional[str]:
            import warnings

            warnings.filterwarnings("ignore")
            from Fundamentals.TickerTape import Tickertape

            _t, raw = Tickertape().get_ticker(isin_, search_place="stock")
            hits = raw if isinstance(raw, list) else []
            return (hits[0].get("ticker") or "").upper() or None if hits else None

        try:
            t = await asyncio.to_thread(tickertape, isin)
            if t:
                return t, 0
        except Exception as e:
            logger.info("Tickertape ISIN lookup failed for %s: %s", isin, e)
        if TapetideBudget.status()["exhausted"]:
            return None, 0
        return await self._tapetide_resolve(isin), 1

    async def _tapetide_resolve(self, query: str) -> Optional[str]:
        client = TapetideMcpClient()
        try:
            res = await client.call_tool("search_stocks", {"query": query, "limit": 1})
            TapetideBudget.record(1)
            hit = (res.get("data") or [None])[0] or {}
            return (hit.get("nse_symbol") or hit.get("symbol") or "").upper() or None
        except Exception as e:
            TapetideBudget.record(0, exhausted=TapetideBudget.is_quota_error(str(e)))
            return None
        finally:
            await client.close()

    async def _fetch_tapetide(self, symbol: str, plan: dict[str, tuple[str, dict]]) -> tuple[dict, dict, int, bool]:
        """Returns (raw, errors, calls_made, quota_hit). Financial statements are split by section."""
        client = TapetideMcpClient()
        sem = asyncio.Semaphore(self.concurrency)
        raw: dict[str, Any] = {}
        errors: dict[str, str] = {}
        state = {"ok": 0, "quota": False}

        async def one(key: str, tool: str, extra: dict):
            async with sem:
                if state["quota"]:
                    errors[key] = "skipped: daily limit reached"
                    return
                try:
                    raw[key] = await asyncio.wait_for(client.call_tool(tool, {"symbol": symbol, **extra}), timeout=25)
                    state["ok"] += 1
                except Exception as e:
                    msg = str(e)[:240]
                    errors[key] = msg
                    if TapetideBudget.is_quota_error(msg):
                        state["quota"] = True

        try:
            await asyncio.gather(*(one(k, t, a) for k, (t, a) in plan.items()))
        finally:
            await client.close()
        TapetideBudget.record(state["ok"], exhausted=state["quota"])

        fin = raw.pop("financials", None)
        if fin:
            raw.update(_split_financials(fin))
        return raw, errors, state["ok"], state["quota"]

    async def _fetch_prices(self, instrument: Optional[Instrument], ticker: str, bse_code: Optional[str] = None):
        """Dhan 2Y daily (stock + NIFTY 50) → Yahoo chart (free) → Tapetide (~6 months, 1 call)."""
        to_d = date.today()
        from_d = to_d - timedelta(days=self.history_days)
        df = bench = None
        dhan_err = None
        if instrument is not None:
            try:
                from backend.services.dhan_client import DhanClient

                client = DhanClient()
                try:
                    df = await client.get_historical_daily_data(
                        security_id=str(instrument.security_id), exchange_segment="NSE_EQ",
                        instrument="EQUITY", from_date=from_d, to_date=to_d)
                    if df is not None and not df.empty:
                        bench = await client.get_historical_daily_data(
                            security_id=self._nifty_security_id(), exchange_segment="IDX_I",
                            instrument="INDEX", from_date=from_d, to_date=to_d)
                finally:
                    await client.close()
            except Exception as e:
                dhan_err = str(e)
                logger.info("Dhan history unavailable for %s: %s", ticker, e)
        yrange = "5y" if self.history_days > 730 else "2y"
        yahoo = YahooPrices()
        if df is not None and not df.empty:
            if bench is None or bench.empty:
                try:
                    bench = await yahoo.daily("^NSEI", yrange)
                except Exception as e:
                    logger.info("Yahoo NIFTY history unavailable: %s", e)
            return df, bench, "Dhan historical (daily, 2 years)", None

        # Yahoo: NSE listing, then BSE code
        for ysym in [f"{ticker}.NS"] + ([f"{bse_code}.BO"] if bse_code else []):
            if _is_isin(ticker):
                break
            try:
                ydf = await yahoo.daily(ysym, yrange)
                if ydf is not None and len(ydf) > 30:
                    try:
                        bench = await yahoo.daily("^NSEI", yrange)
                    except Exception:
                        bench = None
                    note = ("Dhan history unavailable (its access token looks expired), so candles come from Yahoo Finance."
                            if instrument is not None else None)
                    return ydf, bench, f"Yahoo Finance ({ysym}, daily)", note
            except Exception as e:
                logger.info("Yahoo history unavailable for %s: %s", ysym, e)

        if TapetideBudget.status()["exhausted"]:
            return None, None, "unavailable", "No price history: Dhan and Yahoo failed and the Tapetide daily limit is used up."
        client = TapetideMcpClient()
        try:
            res = await client.call_tool("get_price_history", {"symbol": ticker, "days": self.history_days})
            TapetideBudget.record(1)
            rows = res.get("data") or []
            if rows:
                df = pd.DataFrame(rows).rename(columns={"date": "timestamp"})
                df["timestamp"] = pd.to_datetime(df["timestamp"])
                return (df[["timestamp", "open", "high", "low", "close", "volume"]], None,
                        "Tapetide price history (fallback)",
                        "Dhan and Yahoo history unavailable — only ~6 months of candles, so the 200-DMA, trend "
                        "template, stage analysis and relative strength are limited.")
        except Exception as e:
            TapetideBudget.record(0, exhausted=TapetideBudget.is_quota_error(str(e)))
            logger.info("Tapetide price history unavailable for %s: %s", ticker, e)
        finally:
            await client.close()
        return None, None, "unavailable", "No price history from Dhan, Yahoo or Tapetide."

    @staticmethod
    def _nifty_security_id() -> str:
        for spec in (get_config().get("index_trading") or {}).get("indices") or []:
            if str(spec.get("name", "")).upper().replace(" ", "") in ("NIFTY50", "NIFTY"):
                return str(spec.get("security_id"))
        return "13"

    # ───────────────────────── verdict ─────────────────────────

    def _verdict(self, fund: dict, tech: dict) -> dict:
        f = fund.get("score") if fund.get("available") else None
        t = tech.get("score") if tech.get("available") else None
        wf, wt = float(self.weights.get("fundamental", 0.55)), float(self.weights.get("technical", 0.45))
        if f is not None and t is not None:
            combined = round(f * wf + t * wt)
        else:
            combined = f if f is not None else t

        def band(x: Optional[int]) -> str:
            if x is None:
                return "n/a"
            return "Strong" if x >= 75 else "Positive" if x >= 60 else "Neutral" if x >= 45 else "Weak" if x >= 30 else "Poor"

        fs, ts = f if f is not None else 50, t if t is not None else 50
        if fs >= 60 and ts >= 60:
            quadrant, stance = "Quality in momentum", (
                "Fundamentals and price trend agree. This is the techno-funda sweet spot; the main risk is "
                "paying up after an extended run, so watch the distance from the 50-DMA.")
        elif fs >= 60 and ts < 45:
            quadrant, stance = "Good business, weak chart", (
                "The business scores well but the stock is not in an uptrend. Patient investors usually wait "
                "for the trend to turn (reclaiming the 50/200-DMA) rather than catching a falling knife.")
        elif fs >= 60:
            quadrant, stance = "Good business, chart undecided", (
                "Fundamentals are supportive while the chart is neutral. A watchlist candidate: a breakout "
                "above resistance on volume would confirm.")
        elif fs < 45 and ts >= 60:
            quadrant, stance = "Momentum without fundamental support", (
                "Price is strong but the numbers do not back it up. Treat it as a trading setup with a strict "
                "stop, not a long-term holding.")
        elif fs < 45 and ts < 45:
            quadrant, stance = "Weak on both counts", (
                "Neither the business metrics nor the chart offer an edge right now.")
        else:
            quadrant, stance = "Mixed signals", (
                "Strengths and weaknesses roughly offset. No clear techno-funda edge; let either the results "
                "or the chart resolve first.")

        # What would change the view
        triggers: list[str] = []
        if tech.get("available"):
            lv = tech.get("levels") or {}
            res = (lv.get("resistances") or [{}])[0].get("price") if lv.get("resistances") else None
            sup = (lv.get("supports") or [{}])[0].get("price") if lv.get("supports") else None
            ma = {m["name"]: m for m in (tech.get("trend") or {}).get("moving_averages") or []}
            if res:
                triggers.append(f"Bullish trigger: daily close above ₹{res:,.2f} (nearest resistance) on above-average volume.")
            s200 = (ma.get("SMA 200") or {}).get("value")
            if s200 and tech.get("last_close") and tech["last_close"] < s200:
                triggers.append(f"Trend repair: reclaim the 200-DMA at ₹{s200:,.2f}.")
            if sup:
                triggers.append(f"Bearish trigger: close below ₹{sup:,.2f} (nearest support).")
        g = (fund.get("growth") or {}) if fund.get("available") else {}
        if g.get("latest_quarter"):
            triggers.append(f"Next results: does profit growth hold up versus {g.get('latest_quarter')} "
                            f"({_signed(g.get('profit_yoy_q'))} YoY)?")

        positives = (fund.get("green_flags") or [])[:4]
        negatives = (fund.get("red_flags") or [])[:4]
        if tech.get("available"):
            for pillar, label in (("trend", "Trend"), ("momentum", "Momentum"), ("relative_strength", "Relative strength")):
                v = (tech.get("pillars") or {}).get(pillar)
                if v is None:
                    continue
                if v >= 70:
                    positives.append(f"{label} is strong ({v}/100)")
                elif v <= 35:
                    negatives.append(f"{label} is weak ({v}/100)")

        return {
            "score": combined, "rating": band(combined),
            "fundamental_score": f, "fundamental_rating": band(f),
            "technical_score": t, "technical_rating": band(t), "technical_bias": tech.get("bias"),
            "quadrant": quadrant, "summary": stance,
            "positives": positives[:6], "negatives": negatives[:6], "triggers": triggers,
            "weights": {"fundamental": wf, "technical": wt},
        }


_SOURCE_NAMES = {"screener": "Screener.in", "tickertape": "Tickertape", "tapetide": "Tapetide MCP", "wikipedia": "Wikipedia"}
_BUSINESS_SOURCES = {"peers": "screener", "wiki": "wikipedia", "annual_report": "tapetide"}


def _sources_summary(sections: dict) -> str:
    """'Screener.in (statements, shareholding) · Tickertape (pledge, scorecard) · …'"""
    labels = {"quarterly": "statements", "profit_loss": "statements", "balance_sheet": "statements",
              "cash_flow": "statements", "ratios": "statements", "profile": "key ratios", "shareholding": "shareholding",
              "pledge": "pledge", "scorecard": "scorecard", "forecasts": "analyst estimates", "concall": "concall",
              "news": "news", "peers": "peers", "wiki": "company background", "annual_report": "annual report digest"}
    by_src: dict[str, list[str]] = {}
    for key, src in sections.items():
        name = src.split(" ")[0]
        what = labels.get(key, key.replace("_", " "))
        bucket = by_src.setdefault(_SOURCE_NAMES.get(name, name) + (" (saved)" if "saved" in src else ""), [])
        if what not in bucket:
            bucket.append(what)
    return " · ".join(f"{k} ({', '.join(v)})" for k, v in by_src.items()) or "none"


def _signed(v: Optional[float]) -> str:
    return "n/a" if v is None else f"{v:+.1f}%"
