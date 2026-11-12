"""
Swing engine: one end-of-day run finds, scores and ranks VCP / Flag / IPO setups.

Pipeline (compute is kept low: Dhan is only called for stocks new to the universe)
  1. NSE intel     results calendar, ASM/GSM surveillance, bulk/block deals (1 request each)
  2. Bhavcopy      every session since the last run (1 download per day, all stocks)
  3. Universe      EQ series, price band, 20-day turnover >= min, no GSM / short-term ASM / ASM Stage II+
                   (long-term ASM Stage I stays in, flagged and slightly penalised)
  4. Candles       back-fill new names from Dhan once, then append bhavcopy rows
  5. Pass 1        features + the three detectors per stock (one frame in memory at a time)
  6. Context       RS rating (percentile across the universe), market regime, sector strength
  7. Score / rank  0..100, tiers, a short action list ("top picks") and a ranked watchlist
  8. Persist       setup lifecycle in swing_setups; plans frozen when first suggested
  9. Accuracy      every suggested plan is forward-tested on the candles that followed
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import date, datetime, timedelta
from typing import Any, Callable, Optional

import pandas as pd
from sqlalchemy.orm import Session

from backend.models.tables import Instrument, SectorScore, SwingSetup
from backend.services.swing import indicators as ind
from backend.services.swing import nse_data
from backend.services.swing.candles import CandleStore, fetch_dhan_daily, merge, previous_sessions
from backend.services.swing.evaluator import evaluate_plan
from backend.services.swing.regime import compute_regime
from backend.services.swing.settings import get_settings, position_size, setup_params
from backend.services.swing.setups import Candidate, detect_flag, detect_ipo, detect_vcp
from backend.services.swing.timing import estimate_days

logger = logging.getLogger(__name__)

NIFTY_KEY, NIFTY_SID = "IDX_13", "13"
SETUP_TYPES = ("VCP", "FLAG", "IPO")
TIERS = ((80, "A+"), (70, "A"), (60, "B"))
WEIGHTS = {"pattern": 35, "trend": 15, "rs": 15, "sector": 15, "smart_money": 12, "risk": 8}

status: dict[str, Any] = {"running": False, "phase": "idle", "done": 0, "total": 0, "started_at": None,
                          "finished_at": None, "error": None, "summary": None}
_lock = asyncio.Lock()


def _stat(**kw) -> None:
    status.update(kw)


def tier_for(score: float) -> str:
    for thr, t in TIERS:
        if score >= thr:
            return t
    return "C"


def _band(x: Optional[float], steps: list[tuple[float, float]], default: float) -> float:
    if x is None:
        return default
    for thr, s in steps:
        if x >= thr:
            return s
    return default


# ── context helpers ───────────────────────────────────────────────────────

def sector_context(db: Session) -> dict:
    """{sector_name: {'rank', 'of', 'score', 'quadrant'}} from the latest sector analysis + rotation."""
    latest = db.query(SectorScore.date).order_by(SectorScore.date.desc()).first()
    out: dict[str, dict] = {}
    if latest:
        rows = (db.query(SectorScore).filter(SectorScore.date == latest[0])
                .order_by(SectorScore.combined_score.desc()).all())
        for i, r in enumerate(rows, start=1):
            out[r.sector_name] = {"rank": i, "of": len(rows), "score": r.combined_score, "as_of": str(latest[0])}
    try:
        from backend.services.sector_rotation import load_rotation

        rot = load_rotation()
        for s in ((rot.get("timeframes") or {}).get("weekly") or {}).get("sectors", []):
            out.setdefault(s["sector_name"], {})["quadrant"] = s.get("quadrant")
    except Exception as e:
        logger.debug("rotation unavailable: %s", e)
    return out


def sector_factor(ctx: Optional[dict]) -> float:
    if not ctx or not ctx.get("rank"):
        return 0.45
    rank, of = ctx["rank"], max(1, ctx.get("of") or 1)
    base = 1.0 if rank <= 3 else 0.85 if rank <= 5 else 0.6 if rank <= of / 2 else 0.35 if rank <= of - 3 else 0.15
    base += {"Leading": 0.1, "Improving": 0.05, "Weakening": -0.05, "Lagging": -0.15}.get(ctx.get("quadrant"), 0)
    return max(0.0, min(1.0, base))


def smart_money(f: ind.Features, cand: Candidate, deals: dict) -> tuple[float, list[str]]:
    notes = []
    udv = _band(f.up_down_vol, [(1.5, 1.0), (1.2, 0.75), (1.0, 0.5)], 0.2)
    if f.up_down_vol and f.up_down_vol >= 1.2:
        notes.append(f"Accumulation: up-day volume {f.up_down_vol:.1f}× down-day volume (50d)")
    if f.deliv_recent is not None and f.deliv_base:
        rel = f.deliv_recent / f.deliv_base
        dlv = _band(rel, [(1.2, 1.0), (1.05, 0.7)], 0.4)
        if rel >= 1.15:
            notes.append(f"Delivery rising: {f.deliv_recent:.0f}% vs {f.deliv_base:.0f}% average (real buying, not intraday churn)")
    else:
        dlv = 0.5
    if deals.get("count"):
        net = (deals.get("buy_qty") or 0) - (deals.get("sell_qty") or 0)
        dl = 1.0 if net > 0 else 0.1
        notes.append(("Bulk/block BUY" if net > 0 else "Bulk/block SELL") + " deals in the last 60 days"
                     + (f" ({', '.join(deals.get('clients') or [])})" if net > 0 and deals.get("clients") else ""))
    else:
        dl = 0.5
    smc = 1.0 if any((cand.smc or {}).values()) else 0.5
    return (udv + dlv + dl + smc) / 4, notes


def chart_rows(df: pd.DataFrame, bars: int = 120) -> list[list]:
    t = df.tail(bars)
    return [[r.timestamp.strftime("%Y-%m-%d"), round(r.open, 2), round(r.high, 2), round(r.low, 2),
             round(r.close, 2), int(r.volume)] for r in t.itertuples(index=False)]


# ── engine ────────────────────────────────────────────────────────────────

class SwingEngine:
    def __init__(self, db: Session, *, dhan=None, store: Optional[CandleStore] = None,
                 bhav_fetch: Callable = nse_data.fetch_bhavcopy, intel_fetch: Callable = nse_data.refresh_market_intel,
                 master_fetch: Callable = nse_data.equity_master, today: Optional[date] = None):
        self.db = db
        self.dhan = dhan
        self.store = store or CandleStore()
        self.bhav_fetch, self.intel_fetch, self.master_fetch = bhav_fetch, intel_fetch, master_fetch
        self.today = today
        self.settings = get_settings()
        self.params = setup_params()
        self._px: dict[str, dict] = {}

    # ── data sync ──
    async def _sessions_to_load(self, today: date) -> list[date]:
        from backend.services.market_calendar import is_trading_day

        last = self.store.meta.get("bhav_last")
        seed = int(self.settings["bhav_seed_sessions"])
        days, d = [], today
        while len(days) < 60 and d > today - timedelta(days=120):
            if is_trading_day(d):
                if last and d.isoformat() <= last:
                    break
                days.append(d)
                if not last and len(days) >= seed:
                    break
            d -= timedelta(days=1)
        return sorted(days)

    async def _load_bhav(self, today: date) -> tuple[pd.DataFrame, list[date]]:
        new_days = await self._sessions_to_load(today)
        frames = []
        async with nse_data.httpx.AsyncClient(headers=nse_data._HEADERS, timeout=30, follow_redirects=True) as c:
            for d in new_days:
                df = await self.bhav_fetch(d, c)
                if not df.empty:
                    frames.append(df)
        got = sorted({f["date"].iloc[0].date() for f in frames})
        if got:
            self.store.meta["bhav_last"] = max(got).isoformat()
        # turnover/price stats use the cached files of the last 20 sessions too
        hist = []
        for p in sorted(nse_data.cache_dir().glob("bhav_*.csv"))[-20:]:
            try:
                d = datetime.strptime(p.stem[5:], "%Y%m%d").date()
            except ValueError:
                continue
            if d not in got:
                hist.append(nse_data.parse_bhavcopy(p.read_text(encoding="utf-8"), d))
        all_rows = pd.concat(frames + hist, ignore_index=True) if (frames or hist) else pd.DataFrame()
        return all_rows, got

    def _instrument_maps(self, master: dict) -> tuple[dict[str, Instrument], dict[str, Instrument]]:
        insts = self.db.query(Instrument).filter(Instrument.exchange == "NSE", Instrument.segment == "E",
                                                 Instrument.instrument_type == "ES").all()
        by_isin = {i.isin: i for i in insts if i.isin}
        by_sym = {i.trading_symbol: i for i in insts if i.trading_symbol}
        for sym, rec in master.items():
            if sym not in by_sym and rec.get("isin") in by_isin:
                by_sym[sym] = by_isin[rec["isin"]]
        by_sid = {str(i.security_id): i for i in insts}
        return by_sym, by_sid

    def _universe(self, bhav: pd.DataFrame, by_sym: dict, intel: dict) -> tuple[dict[str, dict], dict]:
        s = self.settings
        stats = {"bhav_symbols": 0, "eq_series": 0, "liquid": 0, "surveillance_excluded": 0,
                 "surveillance_flagged": 0, "unmapped": 0}
        if bhav.empty:
            return {}, stats
        eq = bhav[bhav["series"].isin(nse_data.SWING_SERIES)]
        stats["bhav_symbols"] = int(bhav["symbol"].nunique())
        stats["eq_series"] = int(eq["symbol"].nunique())
        last_day = eq["date"].max()
        latest = eq[eq["date"] == last_day].set_index("symbol")
        turn = eq.groupby("symbol")["turnover"].mean()
        out = {}
        for sym, row in latest.iterrows():
            px = float(row["close"])
            if px < float(s["min_price"]) or (float(s["max_price"]) > 0 and px > float(s["max_price"])):
                continue
            if float(turn.get(sym, 0) or 0) < float(s["min_turnover_cr"]) * 1e7:
                continue
            surv = nse_data.surveillance_info(intel, sym)
            if not nse_data.surveillance_tradeable(surv):
                stats["surveillance_excluded"] += 1
                continue
            stats["surveillance_flagged"] += int(surv is not None)
            inst = by_sym.get(sym)
            if inst is None:
                stats["unmapped"] += 1
                continue
            out[str(inst.security_id)] = {"symbol": sym, "inst": inst}
        stats["liquid"] = len(out)
        return out, stats

    async def _sync_stock(self, sid: str, bhav_by_sym: dict[str, pd.DataFrame], sym: str,
                          prev: dict[date, date], today: date) -> Optional[pd.DataFrame]:
        df = self.store.load(sid)
        fetched = False
        if df is None:
            if self.dhan is None:
                return None
            df = await fetch_dhan_daily(self.dhan, sid, today - timedelta(days=int(self.settings["history_days"])), today)
            fetched = True
            if df is None:
                return None
        rows = bhav_by_sym.get(sym)
        info = {"appended": 0, "gap": False, "adjusted": None}
        if rows is not None and not rows.empty:
            df, info = self.store.apply_bhav_rows(sid, df, rows, prev)
            if info["gap"] and self.dhan is not None:
                last = df["timestamp"].iloc[-1].date()
                extra = await fetch_dhan_daily(self.dhan, sid, last + timedelta(days=1), today)
                df = merge(df, extra)
                fetched = True
                df, info2 = self.store.apply_bhav_rows(sid, df, rows, prev)
                info["appended"] += info2["appended"]
        if info.get("adjusted"):
            logger.info("Swing candles: %s adjusted for a corporate action (ratio %s)", sym, info["adjusted"])
        if fetched or info["appended"] or info.get("adjusted"):
            self.store.save(sid, df, symbol=sym)
        return df

    async def _bench(self, today: date) -> Optional[pd.DataFrame]:
        df = self.store.load(NIFTY_KEY)
        if self.dhan is not None:
            start = (df["timestamp"].iloc[-1].date() + timedelta(days=1)) if df is not None \
                else today - timedelta(days=int(self.settings["history_days"]))
            if start <= today:
                try:
                    new = await fetch_dhan_daily(self.dhan, NIFTY_SID, start, today, index=True)
                    if new is not None:
                        df = merge(df, new)
                        self.store.save(NIFTY_KEY, df, symbol="NIFTY 50")
                except Exception as e:
                    logger.warning("Nifty candles update failed: %s", e)
        return df

    def _ipo_lookup(self, master: dict) -> dict[str, dict]:
        out = {}
        try:
            from backend.services import ipo_tracker

            for r in ipo_tracker.load().get("ipos", []):
                if r.get("symbol"):
                    out[r["symbol"]] = {"listed": r.get("listing_date"), "issue_price": r.get("issue_price")}
        except Exception as e:
            logger.debug("ipo tracker unavailable: %s", e)
        for sym, rec in master.items():
            if sym not in out and rec.get("listed"):
                out[sym] = {"listed": rec["listed"], "issue_price": None}
        return out

    # ── main ──
    async def run(self) -> dict:
        if _lock.locked():
            return {"ok": False, "detail": "A swing scan is already running"}
        async with _lock:
            t0 = time.perf_counter()
            from backend.services.market_calendar import today_ist

            today = self.today or today_ist()
            _stat(running=True, phase="market data", done=0, total=0, error=None, summary=None,
                  started_at=datetime.now().isoformat(timespec="seconds"), finished_at=None)
            own_dhan = False
            try:
                if self.dhan is None:
                    from backend.services.dhan_client import DhanClient

                    self.dhan, own_dhan = DhanClient(), True
                try:
                    intel = await self.intel_fetch()
                except Exception as e:
                    logger.warning("NSE intel refresh failed: %s", e)
                    intel = nse_data.load_market_intel()
                master = await self.master_fetch()
                bhav, new_days = await self._load_bhav(today)
                by_sym, by_sid = self._instrument_maps(master)
                universe, ustats = self._universe(bhav, by_sym, intel)
                if not universe:
                    # NSE unavailable: fall back to stocks already in the store
                    for sid, rec in self.store.meta["stocks"].items():
                        if sid in by_sid and rec.get("symbol"):
                            universe[sid] = {"symbol": rec["symbol"], "inst": by_sid[sid]}
                    ustats["fallback_store"] = len(universe)
                bhav_by_sym = {s: g for s, g in bhav[bhav["date"].dt.date.isin(new_days)].groupby("symbol")} \
                    if new_days and not bhav.empty else {}
                prev = previous_sessions(new_days)
                bench = await self._bench(today)
                bench_close = bench.set_index("timestamp")["close"] if bench is not None else None
                ipo_info = self._ipo_lookup(master)

                _stat(phase="candles + patterns", total=len(universe))
                raw: list[dict] = []
                rs_vals: dict[str, Optional[float]] = {}
                breadth = {"n": 0, "above50": 0, "above200": 0, "new_highs": 0, "new_lows": 0}
                failures = 0
                for i, (sid, u) in enumerate(universe.items(), start=1):
                    _stat(done=i)
                    try:
                        df = await self._sync_stock(sid, bhav_by_sym, u["symbol"], prev, today)
                    except Exception as e:
                        failures += 1
                        logger.warning("Swing candles failed for %s: %s", u["symbol"], e)
                        continue
                    if df is None or len(df) < self.params.ipo_min_bars + 1:
                        continue
                    if (today - df["timestamp"].iloc[-1].date()).days > 7:
                        continue            # stale (suspended / delisted)
                    try:
                        f = ind.features(df, bench_close)
                    except Exception as e:
                        logger.debug("features failed %s: %s", u["symbol"], e)
                        continue
                    rs_vals[sid] = ind.rs_raw(df["close"])
                    self._px[sid] = {"close": f.close, "high": float(df["high"].iloc[-1])}
                    breadth["n"] += 1
                    breadth["above50"] += int(bool(f.sma50 and f.close > f.sma50))
                    breadth["above200"] += int(bool(f.sma200 and f.close > f.sma200))
                    if len(df) >= 252:
                        breadth["new_highs"] += int(f.close >= f.hi52 * 0.995)
                        breadth["new_lows"] += int(f.close <= f.lo52 * 1.005)
                    for cand in self._detect(df, f, u["symbol"], ipo_info, today):
                        try:
                            timing = estimate_days(df, cand.entry, cand.stop, cand.target1, cand.target2)
                        except Exception as e:      # an estimate must never break the scan
                            logger.debug("timing failed %s: %s", u["symbol"], e)
                            timing = None
                        raw.append({"sid": sid, "u": u, "f": f, "cand": cand, "chart": chart_rows(df),
                                    "overhead": ind.overhead_resistance(df, cand.entry), "timing": timing})
                    if i % 50 == 0:
                        self.store.flush_meta()
                        await asyncio.sleep(0)
                self.store.flush_meta()
                nse_data.prune_bhav_cache()

                n = max(1, breadth["n"])
                breadth_out = {"stocks": breadth["n"], "above50_pct": round(breadth["above50"] / n * 100, 1),
                               "above200_pct": round(breadth["above200"] / n * 100, 1),
                               "new_highs": breadth["new_highs"], "new_lows": breadth["new_lows"]}
                regime = compute_regime(bench, breadth_out)
                ranks = ind.percentile_ranks(rs_vals)
                sectors = sector_context(self.db)

                _stat(phase="ranking")
                scored = [self._score(r, ranks, sectors, intel, regime, today) for r in raw]
                # Setups are dated by the last session in the data, not the run date: a scan run before
                # today's bhavcopy uses yesterday's candles, and today's candle must still be replayed.
                data_day = max(new_days) if new_days else (
                    date.fromisoformat(self.store.meta["bhav_last"]) if self.store.meta.get("bhav_last") else today)
                saved = self._persist(scored, regime, data_day)
                picks = self._pick(regime, saved.pop("previous_picks"), data_day)
                acc = self.evaluate_suggestions(data_day)

                summary = {
                    "ok": True, "as_of": (max(new_days).isoformat() if new_days else self.store.meta.get("bhav_last")),
                    "universe": ustats, "scanned": breadth["n"], "candle_failures": failures,
                    "setups": {t: sum(1 for s in scored if s["setup"] == t) for t in SETUP_TYPES},
                    "top_picks": len(picks), "regime": regime, "saved": saved, "accuracy_updated": acc,
                    "new_bhav_days": [d.isoformat() for d in new_days], "seconds": round(time.perf_counter() - t0, 1),
                    "intel_errors": intel.get("errors") or [],
                }
                _save_last_run(summary)
                _stat(summary=summary)
                logger.info("Swing scan: %s setups, %s top picks, regime %s, %.0fs", len(scored), len(picks),
                            regime["label"], summary["seconds"])
                return summary
            except Exception as e:
                logger.error("Swing scan failed: %s", e, exc_info=True)
                _stat(error=str(e)[:300])
                return {"ok": False, "detail": str(e)[:300]}
            finally:
                if own_dhan and self.dhan is not None:
                    await self.dhan.close()
                _stat(running=False, phase="idle", finished_at=datetime.now().isoformat(timespec="seconds"))

    def _detect(self, df: pd.DataFrame, f: ind.Features, sym: str, ipo_info: dict, today: date) -> list[Candidate]:
        out = []
        for fn in (detect_vcp, detect_flag):
            try:
                c = fn(df, f, self.params)
                if c:
                    out.append(c)
            except Exception as e:
                logger.debug("%s failed on %s: %s", fn.__name__, sym, e)
        info = ipo_info.get(sym)
        if info and info.get("listed"):
            try:
                age = (today - date.fromisoformat(str(info["listed"])[:10])).days
                c = detect_ipo(df, f, self.params, listing_age_days=age, issue_price=info.get("issue_price"))
                if c:
                    out.append(c)
            except Exception as e:
                logger.debug("detect_ipo failed on %s: %s", sym, e)
        return out

    def _score(self, r: dict, ranks: dict, sectors: dict, intel: dict, regime: dict, today: date) -> dict:
        f: ind.Features = r["f"]
        cand: Candidate = r["cand"]
        inst: Instrument = r["u"]["inst"]
        sym = r["u"]["symbol"]
        rs = ranks.get(r["sid"])
        sec_name = inst.sector
        if not sec_name:
            from backend.services.sector_mapping import sectors_for_instrument

            secs = sectors_for_instrument(inst)
            sec_name = secs[0] if secs else None
        sctx = sectors.get(sec_name) if sec_name else None

        if cand.setup == "IPO":
            trend = 0.5 * float(bool(f.ema21 and f.close > f.ema21)) + 0.5 * float(bool(f.ema10 and f.close > f.ema10))
        else:
            trend = sum(f.template.values()) / len(f.template)
        rs_c = min(1.0, (rs or 50) / 99 + (0.1 if f.rs_line_new_high else 0))
        deals = nse_data.institutional_deals(intel, sym)
        sm, sm_notes = smart_money(f, cand, deals)
        risk_band = 1.0 if cand.risk_pct <= 4 else 0.8 if cand.risk_pct <= 6 else 0.55 if cand.risk_pct <= 8 else 0.2
        overhead = r["overhead"]
        rr_room = (overhead - cand.entry) / (cand.entry - cand.stop) if overhead and cand.entry > cand.stop else None
        room = 1.0 if overhead is None else (1.0 if rr_room >= 3 else 0.7 if rr_room >= 2 else 0.35)
        comp = {
            "pattern": cand.pattern_q, "trend": trend, "rs": rs_c, "sector": sector_factor(sctx),
            "smart_money": sm, "risk": (risk_band + room) / 2,
        }
        score = sum(WEIGHTS[k] * v for k, v in comp.items())
        reasons = list(cand.reasons) + sm_notes
        warnings = list(cand.warnings)
        if rs is not None:
            reasons.append(f"RS rating {rs}" + (" — RS line at a new high (leader)" if f.rs_line_new_high else ""))
            if rs < 70:
                warnings.append(f"RS rating {rs} is below 70: not a market leader")
        if sctx and sctx.get("rank"):
            reasons.append(f"Sector {sec_name}: #{sctx['rank']} of {sctx.get('of')}"
                           + (f", {sctx['quadrant']}" if sctx.get("quadrant") else ""))
            if sctx.get("quadrant") == "Lagging":
                warnings.append(f"{sec_name} is in the Lagging rotation quadrant")
        if overhead is None:
            reasons.append("No overhead supply: at/near all-time highs")
        elif rr_room is not None and rr_room < 2:
            warnings.append(f"Resistance at ₹{overhead:,.2f} is only {rr_room:.1f}R above the entry")
        ev = nse_data.next_event(intel, sym, today)
        blocked = False
        if ev:
            msg = f"{ev['purpose'] or 'Board meeting'} on {ev['date']} ({ev['days']}d): gap risk"
            warnings.append(msg)
            blocked = ev["days"] <= int(self.settings["earnings_block_days"])
        surv = nse_data.surveillance_info(intel, sym)
        if surv:
            warnings.append(f"Under NSE {nse_data.surveillance_label(surv)}: 100% margin, and the exchange can tighten "
                            "the price band if the stage escalates. Use a smaller size.")
            score *= 0.95
        if cand.wide:
            score *= 0.85
        if f.avg_turnover20 < 10e7:
            warnings.append(f"Thin liquidity: ₹{f.avg_turnover20 / 1e7:.1f} Cr/day average")
        score = round(min(100.0, score), 1)
        detail = {
            "levels": cand.levels, "metrics": cand.metrics, "smc": cand.smc, "chart": r["chart"],
            "timing": r.get("timing"),
            "features": {"rs_rating": rs, "mansfield_rs": f.mansfield_rs and round(f.mansfield_rs, 1),
                         "rs_line_new_high": f.rs_line_new_high, "up_down_vol": f.up_down_vol and round(f.up_down_vol, 2),
                         "deliv_recent": f.deliv_recent and round(f.deliv_recent, 1),
                         "deliv_base": f.deliv_base and round(f.deliv_base, 1),
                         "atr_pct": round(f.atr_pct, 2), "from_hi52_pct": round(f.from_hi52_pct, 1),
                         "turnover_cr": round(f.avg_turnover20 / 1e7, 1), "ret_1m": f.ret_1m and round(f.ret_1m, 1),
                         "ret_3m": f.ret_3m and round(f.ret_3m, 1), "vol_ratio_today": round(f.vol_ratio_today, 2),
                         "template": f.template, "sma50": f.sma50 and round(f.sma50, 2),
                         "ema21": f.ema21 and round(f.ema21, 2)},
            "event": ev, "deals": deals if deals.get("count") else None, "overhead": overhead, "surveillance": surv,
            "is_fno": bool(inst.is_fno), "wide": cand.wide, "event_blocked": blocked,
        }
        return {
            "sid": r["sid"], "symbol": sym, "name": inst.display_name, "isin": inst.isin, "setup": cand.setup,
            "status": cand.status, "score": score, "tier": tier_for(score), "components": {k: round(v, 3) for k, v in comp.items()},
            "reasons": reasons, "warnings": warnings, "detail": detail, "sector": sec_name,
            "sector_rank": sctx.get("rank") if sctx else None, "rs": rs, "close": round(f.close, 2),
            "entry": cand.entry, "stop": cand.stop, "target1": cand.target1, "target2": cand.target2,
            "risk_pct": cand.risk_pct, "wide": cand.wide, "event_blocked": blocked,
        }

    # ── lifecycle ──
    # A setup keeps its identity across days (consistency):
    #  * once suggested, its plan (entry / stop / targets) is frozen; fresh levels are only shown as a note
    #  * after a breakout it stays visible as "Breakout · day N" / Extended until it fails, hits the
    #    stop or ages out (the detector no longer sees a base once the stock has broken out)
    #  * a ready/forming setup the detector misses for a day or two is carried on its last plan
    #  * yesterday's top picks keep their place while they remain actionable
    GRACE_SESSIONS = 2
    BREAKOUT_SESSIONS = 5

    def _timing(self, sid: str, entry, stop, t1, t2) -> Optional[dict]:
        """Holding-time estimate for exactly the levels on the card (cheap: ~10 ms from the candle store)."""
        try:
            return estimate_days(self.store.load(sid), entry, stop, t1, t2) if entry and stop and t1 and t2 else None
        except Exception as e:
            logger.debug("timing failed for %s: %s", sid, e)
            return None

    def _status_for(self, setup: str, close: float, high: float, entry: float) -> str:
        from backend.services.swing.setups import classify

        ready = self.params.ipo_ready_pct if setup == "IPO" else None
        return classify(close, entry, high, 1.0, self.params, ready_pct=ready)

    @staticmethod
    def _detail(row: SwingSetup) -> dict:
        try:
            return json.loads(row.detail or "{}")
        except ValueError:
            return {}

    def _mark_days(self, d: dict, today: date, status: str) -> None:
        """Track the breakout day and the sessions since it (re-runs on the same data day count once)."""
        days = set(d.get("seen_days") or [])
        days.add(today.isoformat())
        d["seen_days"] = sorted(days)[-15:]
        d["as_of"] = today.isoformat()
        if status in ("triggered", "extended") and not d.get("broke_out_on"):
            d["broke_out_on"] = today.isoformat()
        if d.get("broke_out_on"):
            d["breakout_age"] = sum(1 for x in d["seen_days"] if x > d["broke_out_on"])

    def _persist(self, scored: list[dict], regime: dict, today: date) -> dict:
        db = self.db
        active = {(r.security_id, r.setup_type): r for r in db.query(SwingSetup).filter(SwingSetup.active.is_(True)).all()}
        previous_picks = {r.id for r in active.values() if r.top_pick}
        db.query(SwingSetup).filter(SwingSetup.top_pick.is_(True)).update({SwingSetup.top_pick: False})
        seen, created, updated, carried, closed = set(), 0, 0, 0, 0
        for s in scored:
            key = (s["sid"], s["setup"])
            seen.add(key)
            row = active.get(key)
            if row is None:
                row = SwingSetup(security_id=s["sid"], symbol=s["symbol"], setup_type=s["setup"], first_seen=today,
                                 last_seen=today, status=s["status"], active=True)
                db.add(row)
                created += 1
            else:
                updated += 1
            prev = self._detail(row) if row.id else {}
            d = dict(s["detail"])
            for k in ("seen_days", "broke_out_on"):
                if prev.get(k):
                    d[k] = prev[k]
            entry, stop, t1, t2, risk, status = s["entry"], s["stop"], s["target1"], s["target2"], s["risk_pct"], s["status"]
            if row.suggested_on is not None and row.plan_entry:
                # frozen plan: same numbers every day; the detector's fresh levels become a note
                fresh = {"entry": entry, "stop": stop, "target1": t1, "target2": t2}
                entry, stop, t1, t2 = row.plan_entry, row.plan_stop, row.plan_t1, row.plan_t2
                risk = round((entry - stop) / entry * 100, 2)
                if abs(fresh["entry"] / entry - 1) > 0.005 or abs(fresh["stop"] / stop - 1) > 0.005:
                    d["fresh_levels"] = fresh
                    d["timing"] = self._timing(s["sid"], entry, stop, t1, t2)   # estimate for the plan shown
                px = self._px.get(s["sid"]) or {"close": s["close"], "high": s["close"]}
                status = self._status_for(s["setup"], px["close"], px["high"], entry) or "forming"
                if px["close"] < stop:
                    status = "invalidated"
            self._mark_days(d, today, status)
            row.name = s["name"]
            row.status, row.tier, row.score = status, s["tier"], s["score"]
            row.components = json.dumps(s["components"])
            row.reasons, row.warnings = json.dumps(s["reasons"]), json.dumps(s["warnings"])
            row.detail = json.dumps(d, default=str)
            row.sector, row.sector_rank, row.rs_rating, row.regime = s["sector"], s["sector_rank"], s["rs"], regime["label"]
            row.close, row.entry, row.stop, row.target1, row.target2, row.risk_pct = s["close"], entry, stop, t1, t2, risk
            row.last_seen = today
            if status == "invalidated":
                row.active = False
                closed += 1
                continue
            if row.suggested_on is None and status in ("ready", "triggered") and s["tier"] in ("A+", "A", "B") \
                    and not s["wide"]:
                row.suggested_on = today
                row.plan_entry, row.plan_stop, row.plan_t1, row.plan_t2 = entry, stop, t1, t2
                row.plan_score, row.plan_tier, row.plan_regime = s["score"], s["tier"], regime["label"]
                row.eval_status = "pending"

        for key, row in active.items():
            if key in seen:
                continue
            outcome = self._carry(row, today)
            if outcome == "carried":
                carried += 1
            else:
                row.active = False
                row.status = outcome
                closed += 1
        db.commit()
        return {"created": created, "updated": updated, "carried": carried, "closed": closed,
                "previous_picks": previous_picks}

    def _carry(self, row: SwingSetup, today: date) -> str:
        """A setup the detector did not find today: keep it on its last plan, or say why it ended."""
        px = self._px.get(row.security_id)
        if px is None or not row.entry or not row.stop:
            return "expired"
        close, high = px["close"], px["high"]
        d = self._detail(row)
        if close < row.stop:
            return "invalidated"
        if d.get("broke_out_on") or row.status in ("triggered", "extended") or close >= row.entry:
            if close < row.entry * 0.98:
                return "failed"                       # closed back inside the base: failed breakout
            if close < row.entry:
                status = "ready"                      # retest of the pivot: the buy-stop at the entry still applies
            else:
                status = "triggered" if close <= row.entry * (1 + self.params.max_chase_pct / 100) else "extended"
            self._mark_days(d, today, status)
            if d.get("breakout_age", 0) > self.BREAKOUT_SESSIONS:
                return "expired"
        else:
            status = self._status_for(row.setup_type, close, high, row.entry)
            if status not in ("ready", "forming"):
                return "expired"
            missed = d.get("missed_days") or []
            if today.isoformat() not in missed:
                missed.append(today.isoformat())
            d["missed_days"] = missed[-10:]
            if len(missed) > self.GRACE_SESSIONS:
                return "expired"
            self._mark_days(d, today, status)
        d["carried"] = True
        d["timing"] = self._timing(row.security_id, row.entry, row.stop, row.target1, row.target2)
        row.status, row.close = status, round(close, 2)
        row.detail = json.dumps(d, default=str)
        return "carried"

    def _pick(self, regime: dict, previous: set, today: date) -> list[SwingSetup]:
        """Top picks from the stored lifecycle: yesterday's picks keep their place while still actionable."""
        allowed = {"uptrend": {"A+", "A"}, "caution": {"A+"}, "downtrend": set()}[regime["label"]]
        rows = self.db.query(SwingSetup).filter(SwingSetup.active.is_(True), SwingSetup.dismissed.isnot(True)).all()

        def eligible(r: SwingSetup) -> bool:
            d = self._detail(r)
            return (r.status in ("ready", "triggered") and r.tier in allowed and not d.get("wide")
                    and not d.get("event_blocked") and (r.rs_rating or 0) >= 60)

        pool = [r for r in rows if eligible(r)]
        incumbents = sorted([r for r in pool if r.id in previous], key=lambda r: -(r.score or 0))
        newcomers = sorted([r for r in pool if r.id not in previous],
                           key=lambda r: (-(r.score or 0), r.status != "triggered"))
        picks, seen, per_sector = [], set(), {}
        for r in incumbents + newcomers:
            if r.security_id in seen:
                continue
            sec = r.sector or "?"
            if per_sector.get(sec, 0) >= int(self.settings["max_per_sector"]):
                continue
            picks.append(r)
            seen.add(r.security_id)
            per_sector[sec] = per_sector.get(sec, 0) + 1
            if len(picks) >= int(self.settings["top_picks"]):
                break
        for r in picks:
            r.top_pick = True
            if r.suggested_on == today:
                r.plan_top_pick = True
        self.db.commit()
        return picks

    # ── accuracy ──
    def evaluate_suggestions(self, today: date) -> int:
        db = self.db
        rows = db.query(SwingSetup).filter(SwingSetup.suggested_on.isnot(None),
                                           SwingSetup.eval_status.in_(["pending", "open"])).all()
        n = 0
        cache: dict[str, Optional[pd.DataFrame]] = {}
        for r in rows:
            if r.security_id not in cache:
                cache[r.security_id] = self.store.load(r.security_id)
            df = cache[r.security_id]
            if df is None:
                continue
            after = df[df["timestamp"].dt.date > r.suggested_on]
            res = evaluate_plan({"entry": r.plan_entry, "stop": r.plan_stop, "target1": r.plan_t1, "target2": r.plan_t2},
                                after, max_wait=int(self.settings["max_wait_days"]),
                                max_hold=int(self.settings["max_hold_days"]))
            r.eval_status = res["status"]
            r.triggered_on = date.fromisoformat(res["triggered_on"]) if res["triggered_on"] else None
            r.fill_price = res["fill"]
            r.exit_on = date.fromisoformat(res["exit_on"]) if res["exit_on"] else None
            r.exit_price, r.result_r, r.mfe_r, r.mae_r = res["exit_price"], res["r"], res["mfe_r"], res["mae_r"]
            r.days_held, r.t1_hit = res["days_held"], res["t1_hit"]
            n += 1
        db.commit()
        return n


def _last_run_path():
    from backend.config import DATA_DIR

    p = DATA_DIR / "swing"
    p.mkdir(parents=True, exist_ok=True)
    return p / "last_run.json"


def _save_last_run(summary: dict) -> None:
    _last_run_path().write_text(json.dumps({**summary, "finished_at": datetime.now().isoformat(timespec="seconds")},
                                           default=str), encoding="utf-8")


def load_last_run() -> dict:
    try:
        return json.loads(_last_run_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def sizing_for(entry: float, stop: float, regime_label: Optional[str]) -> dict:
    from backend.services.swing.regime import LABELS

    s = get_settings()
    mult = LABELS.get(regime_label or "uptrend", 1.0) or 0.5   # sizing shown even in a downtrend (at half)
    return position_size(entry, stop, s, mult)
