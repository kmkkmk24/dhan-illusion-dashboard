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
    date(2026, 1, 26),   # Republic Day
    date(2026, 2, 17),   # Maha Shivaratri (tentative)
    date(2026, 3, 10),   # Ramadan / Eid (tentative)
    date(2026, 3, 30),   # Holi
    date(2026, 3, 31),   # Holi
    date(2026, 4, 2),    # Ram Navami
    date(2026, 4, 3),    # Good Friday
    date(2026, 4, 14),   # Ambedkar Jayanti
    date(2026, 5, 1),    # May Day
    date(2026, 5, 25),   # Buddha Purnima
    date(2026, 6, 29),   # Eid ul-Adha (tentative)
    date(2026, 7, 29),   # Muharram (tentative)
    date(2026, 8, 15),   # Independence Day
    date(2026, 8, 16),   # Janmashtami (tentative)
    date(2026, 9, 28),   # Milad-un-Nabi (tentative)
    date(2026, 10, 2),   # Mahatma Gandhi Jayanti
    date(2026, 10, 20),  # Dussehra
    date(2026, 10, 21),  # Dussehra
    date(2026, 11, 9),   # Diwali (Laxmi Puja)
    date(2026, 11, 10),  # Diwali (Balipratipada)
    date(2026, 11, 30),  # Guru Nanak Jayanti
    date(2026, 12, 25),  # Christmas
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


def holidays() -> set[date]:
    # Union: config adds to the built-in list, it never silently drops dates.
    return _config_holidays() | _BUILTIN_HOLIDAYS


def is_trading_day(d: date | None = None) -> bool:
    d = d or today_ist()
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
    return is_trading_day(at.date()) and MARKET_OPEN <= at.time() <= MARKET_CLOSE


def next_trading_day(d: date) -> date:
    nxt = d + timedelta(days=1)
    while not is_trading_day(nxt):
        nxt += timedelta(days=1)
    return nxt
