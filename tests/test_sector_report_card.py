"""Telegram sector report: digest, caption, image card and the send path (image first, text fallback)."""

import asyncio
from datetime import date

import pytest

from backend.services import sector_report_card as rc
from backend.services import telegram_notifier as tn


def _trail(ratio, mom, n=6):
    return [{"t": f"2026-11-{i + 1:02d}", "ratio": ratio - (n - i) * 0.1, "momentum": mom - (n - i) * 0.05} for i in range(n)]


def _rotation():
    def row(name, q, prev, ratio, mom):
        return {"sector_name": name, "quadrant": q, "previous_quadrant": prev, "trail": _trail(ratio, mom)}
    return {
        "available": True, "as_of": "2026-11-11", "benchmark": "Nifty 50", "benchmark_close": 25255.05,
        "benchmark_returns": {"1D": 0.84, "1W": 1.2, "1M": -0.5},
        "timeframes": {
            "daily": {"sectors": [row("Nifty IT", "Lagging", "Weakening", 98.4, 98.5),
                                  row("Nifty Auto", "Improving", "Improving", 99.0, 101.0),
                                  row("Nifty Bank", "Leading", "Leading", 101.5, 101.0),
                                  row("Nifty Metal", "Weakening", "Leading", 100.5, 99.5)]},
            "weekly": {"sectors": [row("Nifty IT", "Lagging", "Weakening", 99.9, 99.0),
                                   row("Nifty Auto", "Improving", "Lagging", 99.5, 100.4),
                                   row("Nifty Bank", "Weakening", "Leading", 100.4, 99.6),
                                   row("Nifty Metal", "Lagging", "Weakening", 99.0, 99.0)]},
        },
        "performance": [{"sector_name": "Nifty Bank", "returns": {"1D": 1.5, "1W": 7.6, "1M": 8.1}}],
    }


RESULTS = [
    {"sector_name": "Nifty Bank", "combined_score": 0.67, "trend": "Moderate"},
    {"sector_name": "Nifty Metal", "combined_score": 0.6, "trend": "Strong"},
    {"sector_name": "Nifty Auto", "combined_score": 0.55, "trend": "Weak"},
    {"sector_name": "Nifty IT", "combined_score": 0.4, "trend": "Bearish"},
]


def test_digest_confirmed_turns_and_board():
    d = rc.build_digest(RESULTS, _rotation(), report_date=date(2026, 11, 11))
    assert d["confirmed"]["Lagging"] == ["Nifty IT"] and d["confirmed"]["Improving"] == ["Nifty Auto"]
    assert d["confirmed"]["Leading"] == []                      # Bank: Leading daily, Weakening weekly
    assert d["turning_up"] == ["Nifty Auto"]                    # Weak trend, Improving on both
    assert d["cooling"] == ["Nifty Metal"]                      # Strong trend, Weakening + Lagging
    assert d["board"][0] == {"name": "Nifty Bank", "score": 67, "trend": "Moderate", "quadrant": "Leading",
                             "returns": {"1D": 1.5, "1W": 7.6, "1M": 8.1}}
    assert ("Nifty IT", "Weakening", "Lagging") in d["moves"]


def test_caption_is_html_safe_and_within_telegram_limit():
    many = [{"sector_name": f"Nifty Sector & Co {i}", "combined_score": 0.5, "trend": "Weak"} for i in range(60)]
    rot = _rotation()
    rot["timeframes"]["daily"]["sectors"] += [
        {"sector_name": r["sector_name"], "quadrant": "Improving", "previous_quadrant": "Lagging", "trail": _trail(99, 101)}
        for r in many]
    rot["timeframes"]["weekly"]["sectors"] += [
        {"sector_name": r["sector_name"], "quadrant": "Improving", "previous_quadrant": "Lagging", "trail": _trail(99, 101)}
        for r in many]
    cap = rc.build_caption(rc.build_digest(many, rot, report_date=date(2026, 11, 11)))
    assert len(cap) <= rc.CAPTION_LIMIT and "&amp;" in cap and "& Co" not in cap
    assert cap.endswith("Tap a sector for its stocks</i>") and _balanced(cap)


def test_card_renders_png():
    png = rc.render_card(rc.build_digest(RESULTS, _rotation(), report_date=date(2026, 11, 11)))
    assert png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) > 20_000


def test_card_renders_without_rotation():
    png = rc.render_card(rc.build_digest(RESULTS, None, report_date=date(2026, 11, 11)))
    assert png[:4] == b"\x89PNG"


@pytest.fixture
def telegram(monkeypatch):
    sent = []
    monkeypatch.setattr(tn, "_telegram_settings", lambda: ("TOKEN", "CHAT"))
    monkeypatch.setattr("backend.services.sector_rotation.load_rotation", lambda *a, **k: _rotation())

    async def photo(**kw):
        sent.append(("photo", kw))
        return {"ok": True, "message_id": 1}

    async def text(**kw):
        sent.append(("text", kw))
        return {"ok": True, "message_id": 2}

    monkeypatch.setattr(tn, "send_telegram_photo", photo)
    monkeypatch.setattr(tn, "send_telegram_message_ex", text)
    return sent


def test_report_is_sent_as_image_with_buttons(telegram):
    out = asyncio.run(tn.send_sector_report(RESULTS, report_date=date(2026, 11, 11)))
    assert out["ok"] and out["format"] == "image"
    kind, kw = telegram[0]
    assert kind == "photo" and kw["photo"][:4] == b"\x89PNG" and "Sector Rotation" in kw["caption"]
    buttons = [b for row in kw["reply_markup"]["inline_keyboard"] for b in row]
    assert buttons[0] == {"text": "🟢 Bank", "callback_data": "sec:Nifty Bank"}
    assert len(buttons) == len(RESULTS)


def test_render_failure_falls_back_to_text(telegram, monkeypatch):
    def boom(_d):
        raise RuntimeError("no fonts")
    monkeypatch.setattr(rc, "render_card", boom)
    out = asyncio.run(tn.send_sector_report(RESULTS, report_date=date(2026, 11, 11)))
    assert out["format"] == "text" and telegram[0][0] == "text"
    assert "All sectors (Daily)" in telegram[0][1]["message"] and telegram[0][1]["reply_markup"]


# ── HTML validity (Telegram rejects unbalanced tags) ──

def _balanced(html: str) -> bool:
    from html.parser import HTMLParser

    allowed = {"b", "i", "u", "s", "code", "pre", "a", "blockquote", "tg-spoiler"}
    stack, ok = [], [True]

    class P(HTMLParser):
        def handle_starttag(self, tag, attrs):
            ok[0] &= tag in allowed
            stack.append(tag)

        def handle_endtag(self, tag):
            ok[0] &= bool(stack) and stack.pop() == tag

    P().feed(html)
    return ok[0] and not stack


def test_caption_uses_quotes_and_is_valid_html():
    cap = rc.build_caption(rc.build_digest(RESULTS, _rotation(), report_date=date(2026, 11, 11)))
    assert "<blockquote>" in cap and "<code>+0.8%</code>" in cap and _balanced(cap)


# ── Sector drill-down ──

def _stock(sym, *, fno=False, lot=None, signal=None, in_dhan=True, company=None):
    return {"symbol": sym, "display_name": company or f"{sym} Industries Limited", "company": company or sym,
            "in_dhan": in_dhan, "is_fno": fno, "lot_size": lot, "has_signal": signal is not None,
            "signal_type": signal, "signal_score": 0.78 if signal else None}


def test_drilldown_sections_buttons_and_html():
    payload = {"sector": "Nifty IT", "as_of": "2026-11-11", "fno_count": 2, "stocks": [
        _stock("TCS", fno=True, lot=175, signal="VCP"),
        _stock("INFY", fno=True, lot=400),
        _stock("M&M<X>", company="A & B <Ltd>"),
        _stock("GONE", in_dhan=False),
    ]}
    stats = {"score": 62, "trend": "Bearish", "daily_quadrant": "Lagging", "weekly_quadrant": "Lagging",
             "returns": {"1D": -0.53, "1W": 0.73, "1M": 13.92}, "turn": None}
    text, kb = rc.build_sector_drilldown(payload, stats)
    assert _balanced(text) and len(text) <= rc.MESSAGE_LIMIT
    assert text.startswith("🔴 <b>Nifty IT</b>") and "✅ <i>confirmed</i>" in text
    assert "⚡ <b>TCS</b> · VCP 78 · lot <code>175</code>" in text
    assert "<b>INFY</b>" in text and "M&amp;M&lt;X&gt;" in text and "Not on Dhan" in text
    assert "<code>-0.5%</code>" in text
    rows = kb["inline_keyboard"]
    assert rows[0][0]["url"] == rc.DHAN_TV_URL
    assert rows[1][0]["copy_text"] == {"text": "TCS,INFY"}


def test_drilldown_fits_telegram_limit_for_big_sectors():
    stocks = [_stock(f"SYM{i:03d}", fno=i % 2 == 0, lot=500 if i % 2 == 0 else None,
                     company="A Very Long Company Name Private Industries") for i in range(400)]
    text, kb = rc.build_sector_drilldown({"sector": "Nifty IPO", "stocks": stocks, "fno_count": 200}, {})
    assert len(text) <= rc.MESSAGE_LIMIT and _balanced(text) and "more not shown" in text
    assert len(kb["inline_keyboard"][1][0]["copy_text"]["text"]) <= 256
    assert not kb["inline_keyboard"][1][0]["copy_text"]["text"].endswith(",")
