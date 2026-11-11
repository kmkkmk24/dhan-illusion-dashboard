from __future__ import annotations

import asyncio
import json
import logging
from datetime import date
from html import escape
from typing import Any

import httpx

from backend.config import get_config
from backend.models.database import get_session_factory
from backend.models.tables import SectorScore

logger = logging.getLogger(__name__)
_TELEGRAM_OFFSET: int = 0


def _telegram_settings() -> tuple[str, str]:
    cfg = get_config().get("telegram") or {}
    token = str(cfg.get("bot_token") or "").strip()
    chat_id = str(cfg.get("chat_id") or "").strip()
    return token, chat_id


def telegram_is_configured() -> bool:
    token, chat_id = _telegram_settings()
    return bool(token and chat_id)


async def send_telegram_message(message: str, *, parse_mode: str = "HTML") -> dict[str, Any]:
    return await send_telegram_message_ex(
        message=message,
        parse_mode=parse_mode,
        reply_markup=None,
    )


async def send_telegram_message_ex(
    *,
    message: str,
    parse_mode: str = "HTML",
    reply_markup: dict[str, Any] | None = None,
    chat_id: str | None = None,
) -> dict[str, Any]:
    token, configured_chat_id = _telegram_settings()
    target_chat = str(chat_id or configured_chat_id or "").strip()
    if not token or not target_chat:
        return {"ok": False, "reason": "telegram_not_configured"}

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": target_chat,
        "text": message,
        "parse_mode": parse_mode,
        "disable_web_page_preview": True,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(url, json=payload)
        data = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
        if response.status_code >= 400 or not data.get("ok"):
            logger.warning("Telegram send failed: status=%s body=%s", response.status_code, data)
            return {
                "ok": False,
                "reason": "telegram_api_error",
                "status_code": response.status_code,
                "error": data.get("description"),
            }
        return {"ok": True, "message_id": (data.get("result") or {}).get("message_id")}
    except Exception as exc:
        logger.exception("Telegram send exception")
        return {"ok": False, "reason": "telegram_exception", "error": str(exc)}


def _trend_emoji(trend: str) -> str:
    t = str(trend or "").lower()
    if "strong" in t:
        return "🟢"
    if "moderate" in t:
        return "🟡"
    if "weak" in t:
        return "🟠"
    if "bear" in t:
        return "🔴"
    return "⚪"


def _fmt_pct_cell(value: Any) -> str:
    try:
        if value is None:
            return "--"
        v = float(value)
        if v <= 1.0:
            v *= 100.0
        return f"{v:>5.0f}%"
    except Exception:
        return "  -- "


def _short_trend(value: Any) -> str:
    t = str(value or "").strip().lower()
    if t.startswith("strong"):
        return "STR"
    if t.startswith("moderate"):
        return "MOD"
    if t.startswith("weak"):
        return "WEK"
    if t.startswith("bear"):
        return "BER"
    return "---"


def _resolve_trend_code(row: dict) -> str:
    trend_raw = str(row.get("trend") or "").strip()
    if trend_raw and trend_raw not in {"—", "-", "--", "---"}:
        return _short_trend(trend_raw)
    try:
        score = float(row.get("combined_score") or 0)
        if score > 1.0:
            score = score / 100.0
    except Exception:
        score = 0.0
    if score >= 0.65:
        return "STR"
    if score >= 0.45:
        return "MOD"
    if score >= 0.25:
        return "WEK"
    return "BER"


def _build_sector_table_lines(results: list[dict]) -> list[str]:
    # Keep table narrow for Telegram mobile width.
    ranked = sorted(results, key=lambda x: float(x.get("combined_score") or 0), reverse=True)
    name_width = 12
    header = f"{'SECTOR':<{name_width}} {'H':>3} {'D':>3} {'W':>3} {'M':>3} {'T':>3} {'S':>4}"
    sep = "-" * len(header)
    lines = [header, sep]
    for row in ranked:
        name = str(row.get("sector_name") or "-").replace("Nifty ", "").strip()
        if len(name) > name_width:
            name = name[: name_width - 1] + "…"
        hourly = _fmt_pct_cell(row.get("hourly_rs") or row.get("daily_rs")).strip()
        daily = _fmt_pct_cell(row.get("daily_rs")).strip()
        weekly = _fmt_pct_cell(row.get("weekly_rs")).strip()
        monthly = _fmt_pct_cell(row.get("monthly_rs")).strip()
        trend = _resolve_trend_code(row)
        score = _fmt_pct_cell(row.get("combined_score")).strip()
        lines.append(f"{name:<{name_width}} {hourly:>3} {daily:>3} {weekly:>3} {monthly:>3} {trend:>3} {score:>4}")
    return lines


def build_sector_report_message(results: list[dict], *, report_date: date, top_n: int = 5) -> str:
    if not results:
        return f"📊 <b>Sector Analysis Report</b> <i>({report_date.isoformat()})</i>\nNo sector data available."

    ranked = sorted(results, key=lambda x: float(x.get("combined_score") or 0), reverse=True)
    table_lines = _build_sector_table_lines(ranked)

    lines: list[str] = [
        f"📊 <b>Sector Analysis Report</b> <i>({report_date.isoformat()})</i>",
        f"Total sectors analyzed: <b>{len(ranked)}</b>",
        "",
        "<b>Dashboard-style Sector Matrix</b>",
        "<pre>",
        *table_lines,
        "</pre>",
        "",
        "Tap a sector button below to get stock-level drill-down.",
    ]

    return "\n".join(lines)


_Q_DOT = {"Leading": "🟢", "Improving": "🔵", "Weakening": "🟠", "Lagging": "🔴"}


def build_sector_report_keyboard(
    results: list[dict], *, top_n: int = 5, quadrants: dict[str, str] | None = None
) -> dict[str, Any] | None:
    """One button per sector (ranked), prefixed with its Daily quadrant colour when known."""
    if not results:
        return None
    ranked = sorted(results, key=lambda x: float(x.get("combined_score") or 0), reverse=True)
    # Expose drill-down access for all sectors in ranked order.
    top = ranked
    buttons: list[list[dict[str, str]]] = []
    row: list[dict[str, str]] = []
    for s in top:
        name = str(s.get("sector_name") or "").strip()
        if not name:
            continue
        dot = _Q_DOT.get((quadrants or {}).get(name, ""), "")
        label = name.replace("Nifty ", "")
        row.append({"text": f"{dot} {label}".strip(), "callback_data": f"sec:{name}"})
        if len(row) == 3:
            buttons.append(row)
            row = []
    if row:
        buttons.append(row)
    return {"inline_keyboard": buttons} if buttons else None


def _sector_stats(session, sector: str) -> dict:
    """Score, trend, rotation quadrants, turn and returns for one sector (best effort)."""
    from backend.services.sector_analyzer import classify_trend
    from backend.services.sector_rotation import load_rotation

    stats: dict[str, Any] = {}
    row = (session.query(SectorScore).filter(SectorScore.sector_name == sector)
           .order_by(SectorScore.date.desc()).first())
    if row is not None:
        stats["score"] = round((row.combined_score or 0) * 100)
        base = row.relative_strength or 0
        stats["trend"] = classify_trend(
            row.daily_rs if row.daily_rs is not None else base,
            row.weekly_rs if row.weekly_rs is not None else base,
            row.monthly_rs if row.monthly_rs is not None else base,
            {"above_20ema": row.is_above_20ema, "above_50ema": row.is_above_50ema,
             "ema_aligned": row.is_ema_aligned, "higher_highs": row.is_making_higher_highs},
        )
    try:
        rotation = load_rotation() or {}
    except Exception:
        rotation = {}
    tfs = rotation.get("timeframes") or {}
    for tf in ("daily", "weekly"):
        hit = next((r for r in (tfs.get(tf) or {}).get("sectors", []) if r.get("sector_name") == sector), None)
        stats[f"{tf}_quadrant"] = hit.get("quadrant") if hit else None
    perf = next((p for p in rotation.get("performance") or [] if p.get("sector_name") == sector), None)
    stats["returns"] = (perf or {}).get("returns") or {}
    d, w, t = stats.get("daily_quadrant"), stats.get("weekly_quadrant"), stats.get("trend")
    if t in ("Weak", "Bearish") and d in ("Improving", "Leading") and w in ("Improving", "Leading"):
        stats["turn"] = "↗ Turning up"
    elif t in ("Strong", "Moderate") and d in ("Weakening", "Lagging") and w in ("Weakening", "Lagging"):
        stats["turn"] = "↘ Cooling"
    return stats


def build_sector_drilldown(sector_name: str) -> tuple[str, dict]:
    """Rich drill-down message + buttons for one sector (official constituents, signals, lots)."""
    from backend.services.sector_mapping import sector_stocks
    from backend.services.sector_report_card import build_sector_drilldown as fmt

    sector = str(sector_name or "").strip()
    session = get_session_factory()()
    try:
        payload = sector_stocks(session, sector)
        stats = _sector_stats(session, sector)
    finally:
        session.close()
    if not payload.get("stocks"):
        return f"📌 <b>{escape(sector)}</b>\nNo constituents found for this sector.", {}
    return fmt(payload, stats)


async def send_telegram_photo(
    *,
    photo: bytes,
    caption: str,
    reply_markup: dict[str, Any] | None = None,
    chat_id: str | None = None,
    filename: str = "report.png",
) -> dict[str, Any]:
    """Send a PNG with an HTML caption (max 1024 chars) and optional inline keyboard."""
    token, configured_chat_id = _telegram_settings()
    target_chat = str(chat_id or configured_chat_id or "").strip()
    if not token or not target_chat:
        return {"ok": False, "reason": "telegram_not_configured"}
    data = {"chat_id": target_chat, "caption": caption, "parse_mode": "HTML"}
    if reply_markup:
        data["reply_markup"] = json.dumps(reply_markup)
    try:
        async with httpx.AsyncClient(timeout=40.0) as client:
            response = await client.post(f"https://api.telegram.org/bot{token}/sendPhoto", data=data,
                                         files={"photo": (filename, photo, "image/png")})
        body = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
        if response.status_code >= 400 or not body.get("ok"):
            logger.warning("Telegram photo send failed: status=%s body=%s", response.status_code, body)
            return {"ok": False, "reason": "telegram_api_error", "status_code": response.status_code,
                    "error": body.get("description")}
        return {"ok": True, "message_id": (body.get("result") or {}).get("message_id")}
    except Exception as exc:
        logger.exception("Telegram photo send exception")
        return {"ok": False, "reason": "telegram_exception", "error": str(exc)}


async def send_sector_report(results: list[dict], *, report_date: date, top_n: int = 5) -> dict[str, Any]:
    """
    Sector report: an image card (quadrants, rotation map, leaderboard) with a short
    caption of the takeaways and one button per sector for the stock drill-down.
    Falls back to a formatted text message if the image can't be rendered or sent.
    """
    from backend.services import sector_report_card as card
    from backend.services.sector_rotation import load_rotation

    if not results:
        return await send_telegram_message_ex(message=build_sector_report_message(results, report_date=report_date),
                                              parse_mode="HTML", reply_markup=None)
    try:
        rotation = load_rotation()
    except Exception:
        rotation = None
    digest = card.build_digest(results, rotation, report_date=report_date)
    keyboard = build_sector_report_keyboard(
        results, top_n=top_n, quadrants={n: r["quadrant"] for n, r in digest["daily"].items()})
    try:
        png = await asyncio.to_thread(card.render_card, digest)
        sent = await send_telegram_photo(photo=png, caption=card.build_caption(digest), reply_markup=keyboard,
                                         filename=f"sectors_{digest['date']}.png")
        if sent.get("ok"):
            return {**sent, "format": "image"}
        logger.warning("Sector card photo failed (%s); sending text instead", sent.get("error"))
    except Exception:
        logger.exception("Sector card render failed; sending text instead")
    sent = await send_telegram_message_ex(message=card.build_text_report(digest), parse_mode="HTML",
                                          reply_markup=keyboard)
    return {**sent, "format": "text"}


async def _telegram_api_call(method: str, payload: dict[str, Any]) -> dict[str, Any]:
    token, _ = _telegram_settings()
    if not token:
        return {"ok": False, "reason": "telegram_not_configured"}
    url = f"https://api.telegram.org/bot{token}/{method}"
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(url, json=payload)
        data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
        if resp.status_code >= 400:
            return {"ok": False, "status_code": resp.status_code, "error": data.get("description")}
        return data
    except Exception as exc:
        return {"ok": False, "reason": "telegram_exception", "error": str(exc)}


async def process_telegram_callbacks() -> dict[str, Any]:
    """Poll Telegram updates and respond to sector drill-down button clicks."""
    global _TELEGRAM_OFFSET
    if not telegram_is_configured():
        return {"ok": False, "reason": "telegram_not_configured"}

    token, _ = _telegram_settings()
    params = {"timeout": 0, "allowed_updates": ["callback_query"]}
    if _TELEGRAM_OFFSET > 0:
        params["offset"] = _TELEGRAM_OFFSET
    url = f"https://api.telegram.org/bot{token}/getUpdates"
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(url, params=params)
        payload = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
    except Exception as exc:
        return {"ok": False, "reason": "telegram_exception", "error": str(exc)}

    if not payload.get("ok"):
        return {"ok": False, "reason": "telegram_api_error", "error": payload.get("description")}

    updates = payload.get("result") or []
    handled = 0
    for upd in updates:
        upd_id = int(upd.get("update_id") or 0)
        if upd_id:
            _TELEGRAM_OFFSET = max(_TELEGRAM_OFFSET, upd_id + 1)
        cb = upd.get("callback_query") or {}
        data = str(cb.get("data") or "")
        if not data.startswith("sec:"):
            continue
        sector_name = data.split("sec:", 1)[1].strip()
        msg = cb.get("message") or {}
        chat_id = ((msg.get("chat") or {}).get("id"))
        cb_id = cb.get("id")
        if not chat_id or not cb_id or not sector_name:
            continue

        detail, keyboard = build_sector_drilldown(sector_name)
        sent = await send_telegram_message_ex(message=detail, parse_mode="HTML", chat_id=str(chat_id),
                                              reply_markup=keyboard or None)
        if not sent.get("ok") and keyboard:
            # e.g. an older Bot API without copy buttons: retry without the keyboard
            await send_telegram_message_ex(message=detail, parse_mode="HTML", chat_id=str(chat_id))
        await _telegram_api_call("answerCallbackQuery", {"callback_query_id": cb_id, "text": f"{sector_name} details sent"})
        handled += 1

    return {"ok": True, "handled": handled, "updates": len(updates)}
