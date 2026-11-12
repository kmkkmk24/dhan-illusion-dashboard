"""
NSE trading calendar, always in IST regardless of the host's time zone.

Holidays come from config.yaml:

    market:
      holidays:
        - 2027-01-26
        - ...

These are added to the built-in 2026 list below. If the current year has no holidays at all, a warning is logged once, since
scans and order flows would then run on exchange holidays.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta

from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
MARKET_OPEN = time(9, 15)
MARKET_CLOSE = time(15, 30)

_BUILTIN_HOLIDAYS = {
    # NSE equity holidays for 2026. Jan–11 Nov are VERIFIED against actual exchange sessions
    # (weekdays with no NIFTY 50 daily candle from Dhan); later dates are from NSE's published list.
    # The earlier list here had 16 wrong dates (e.g. 9 Nov marked closed while the market traded).
    date(2026, 1, 15),   # Maharashtra municipal elections
    date(2026, 1, 26),   # Republic Day
    date(2026, 3, 3),    # Holi
    date(2026, 3, 26),   # Ram Navami
    date(2026, 3, 31),   # Mahavir Jayanti
    date(2026, 4, 3),    # Good Friday
    date(2026, 4, 14),   # Dr. Ambedkar Jayanti
    date(2026, 5, 1),    # Maharashtra Day
    date(2026, 5, 28),   # Bakri Id
    date(2026, 6, 26),   # Muharram
    date(2026, 9, 14),   # Ganesh Chaturthi
    date(2026, 10, 2),   # Mahatma Gandhi Jayanti
    date(2026, 10, 20),  # Dussehra
    date(2026, 11, 10),  # Diwali Balipratipada
    date(2026, 11, 24),  # Guru Nanak Jayanti (NSE list; was wrongly 30 Nov)
    date(2026, 12, 25),  # Christmas
}

# Exchange sessions on days that are normally closed (weekends): Budget day, Muhurat trading.
# date -> (open, close) in IST. Add future ones under market.special_sessions in config.yaml.
_BUILTIN_SPECIAL_SESSIONS = {
    date(2026, 2, 1): (time(9, 15), time(15, 30)),   # Union Budget (Sunday), full session
    date(2026, 11, 8): (time(14, 15), time(15, 30)),  # Diwali Muhurat trading (Sunday)
}

_warned_years: set[int] = set()


def now_ist() -> datetime:
    return datetime.now(IST)


def today_ist() -> date:
    return now_ist().date()


def _config_holidays() -> set[date]:
    try:
        from backend.config import get_config

        raw = ((get_config().get("market") or {}).get("holidays")) or []
    except Exception:
        return set()
    out = set()
    for item in raw:
        try:
            out.add(item if isinstance(item, date) else date.fromisoformat(str(item).strip()))
        except ValueError:
            logger.warning("Ignoring invalid market.holidays entry: %r", item)
    return out


def _config_special_sessions() -> dict[date, tuple[time, time]]:
    """market.special_sessions: [{date: 2027-02-01, open: "09:15", close: "15:30"}, ...]"""
    try:
        from backend.config import get_config

        raw = ((get_config().get("market") or {}).get("special_sessions")) or []
    except Exception:
        return {}
    out: dict[date, tuple[time, time]] = {}
    for item in raw:
        try:
            d = item["date"] if isinstance(item["date"], date) else date.fromisoformat(str(item["date"]).strip())
            o = time.fromisoformat(str(item.get("open", "09:15")))
            c = time.fromisoformat(str(item.get("close", "15:30")))
            out[d] = (o, c)
        except (KeyError, TypeError, ValueError):
            logger.warning("Ignoring invalid market.special_sessions entry: %r", item)
    return out


def special_sessions() -> dict[date, tuple[time, time]]:
    return {**_BUILTIN_SPECIAL_SESSIONS, **_config_special_sessions()}


def holidays() -> set[date]:
    # Union: config adds to the built-in list, it never silently drops dates.
    return _config_holidays() | _BUILTIN_HOLIDAYS


def is_trading_day(d: date | None = None) -> bool:
    d = d or today_ist()
    if d in special_sessions():
        return True
    if d.weekday() >= 5:
        return False
    hols = holidays()
    if d.year not in {h.year for h in hols} and d.year not in _warned_years:
        _warned_years.add(d.year)
        logger.warning(
            "No NSE holidays configured for %s; add them under market.holidays in config.yaml", d.year
        )
    return d not in hols


def is_market_open(at: datetime | None = None) -> bool:
    at = (at or now_ist()).astimezone(IST)
    if not is_trading_day(at.date()):
        return False
    open_t, close_t = special_sessions().get(at.date(), (MARKET_OPEN, MARKET_CLOSE))
    return open_t <= at.time() <= close_t


def next_trading_day(d: date) -> date:
    nxt = d + timedelta(days=1)
    while not is_trading_day(nxt):
        nxt += timedelta(days=1)
    return nxt


def audit_against_sessions(traded: set[date], start: date, end: date) -> dict[str, list[date]]:
    """Compare the calendar with days the exchange actually traded (e.g. NIFTY daily candles).

    Returns {'marked_closed_but_traded': [...], 'traded_calendar_missing_holiday': [...],
             'unlisted_special_sessions': [...]} — all empty when the calendar is right.
    """
    out: dict[str, list[date]] = {"marked_closed_but_traded": [], "closed_but_marked_trading": [],
                                  "unlisted_special_sessions": []}
    d = start
    while d <= end:
        cal_open = is_trading_day(d)
        if d in traded and not cal_open:
            out["unlisted_special_sessions" if d.weekday() >= 5 else "marked_closed_but_traded"].append(d)
        elif d not in traded and cal_open and d.weekday() < 5:
            out["closed_but_marked_trading"].append(d)
        d += timedelta(days=1)
    return out


async def verify_with_dhan(lookback_days: int = 60) -> dict:
    """Startup self-check: fetch NIFTY 50 daily candles and report any calendar mismatch (logged as errors)."""
    from backend.services.dhan_client import DhanClient

    end = today_ist() - timedelta(days=1)  # today's candle only exists after the close
    start = end - timedelta(days=lookback_days)
    client = DhanClient()
    try:
        df = await client.get_historical_daily_data(security_id="13", exchange_segment="IDX_I",
                                                    instrument="INDEX", from_date=start, to_date=end)
    finally:
        await client.close()
    if df is None or df.empty:
        return {"checked": False, "reason": "no NIFTY candles (Dhan token?)"}
    traded = set(df["timestamp"].dt.date)
    res = audit_against_sessions(traded, start, end)
    bad = {k: [d.isoformat() for d in v] for k, v in res.items() if v}
    if bad:
        logger.error("NSE calendar mismatch vs actual sessions (%s → %s): %s. Fix market.holidays / "
                     "market.special_sessions in config.yaml.", start, end, bad)
    else:
        logger.info("NSE calendar verified against actual sessions %s → %s", start, end)
    return {"checked": True, "from": start.isoformat(), "to": end.isoformat(), "mismatches": bad}
