"""
Telegram sector report: an image card plus a short HTML caption.

Both are built from one digest of the sector analysis (scores + rotation), so
the picture and the text always agree:
  * Nifty 50 close and its 1D / 1W / 1M move
  * quadrant counts (Daily) and the sectors confirmed on Daily AND Weekly
  * turns: weak trend gaining on Nifty ("turning up"), strong trend fading ("cooling")
  * rotation map (Daily RRG with short tails)
  * momentum leaderboard with returns
"""

from __future__ import annotations

import io
from datetime import date
from html import escape
from typing import Any, Optional

QUADS = ["Leading", "Improving", "Weakening", "Lagging"]
Q_HINT = {"Leading": "strong & accelerating", "Improving": "weak but gaining",
          "Weakening": "strong but fading", "Lagging": "weak & fading"}
Q_DOT = {"Leading": "🟢", "Improving": "🔵", "Weakening": "🟠", "Lagging": "🔴"}

# Dashboard palette (dark)
BG = "#0b1220"
CARD = "#121b2e"
STROKE = "#1f2a44"
TEXT = "#e2e8f0"
MUTED = "#94a3b8"
FAINT = "#64748b"
ACCENT = "#818cf8"
Q_COLOR = {"Leading": "#22c55e", "Improving": "#38bdf8", "Weakening": "#f59e0b", "Lagging": "#f43f5e"}
UP, DOWN = "#22c55e", "#f43f5e"
TREND_COLOR = {"Strong": "#22c55e", "Moderate": "#f59e0b", "Weak": "#94a3b8", "Bearish": "#f43f5e"}


def short(name: str) -> str:
    return str(name or "").replace("Nifty ", "").strip()


def _pct(v: Optional[float], digits: int = 1) -> str:
    if v is None:
        return "—"
    return f"{'+' if v > 0 else ''}{v:.{digits}f}%"


def _score(v: Any) -> int:
    try:
        f = float(v or 0)
    except (TypeError, ValueError):
        return 0
    return round(f * 100) if f <= 1 else round(f)


# ── digest ──

def build_digest(results: list[dict], rotation: Optional[dict], *, report_date: date, top_n: int = 8) -> dict:
    rotation = rotation if rotation and rotation.get("available") else {}
    tfs = rotation.get("timeframes") or {}
    daily = {r["sector_name"]: r for r in (tfs.get("daily") or {}).get("sectors", [])}
    weekly = {r["sector_name"]: r for r in (tfs.get("weekly") or {}).get("sectors", [])}
    perf = {p["sector_name"]: p.get("returns") or {} for p in rotation.get("performance") or []}
    trend = {r.get("sector_name"): r.get("trend") for r in results}

    # Strength of a reading = distance of its latest point from the centre.
    def dist(r):
        p = (r or {}).get("trail", [{}])[-1] if r and r.get("trail") else None
        return ((p["ratio"] - 100) ** 2 + (p["momentum"] - 100) ** 2) ** 0.5 if p else 0

    quadrants = {q: sorted((n for n, r in daily.items() if r["quadrant"] == q), key=lambda n: -dist(daily[n]))
                 for q in QUADS}
    confirmed = {q: [n for n in quadrants[q] if weekly.get(n, {}).get("quadrant") == q] for q in QUADS}

    turning_up, cooling = [], []
    for name in daily:
        d, w, t = daily[name]["quadrant"], (weekly.get(name) or {}).get("quadrant"), trend.get(name)
        if t in ("Weak", "Bearish") and d in ("Improving", "Leading") and w in ("Improving", "Leading"):
            turning_up.append(name)
        elif t in ("Strong", "Moderate") and d in ("Weakening", "Lagging") and w in ("Weakening", "Lagging"):
            cooling.append(name)

    # Quadrant changes on the latest daily bar.
    moves = [(n, r["previous_quadrant"], r["quadrant"]) for n, r in daily.items()
             if r.get("previous_quadrant") and r["previous_quadrant"] != r["quadrant"]]

    ranked = sorted(results, key=lambda r: float(r.get("combined_score") or 0), reverse=True)
    board = [{
        "name": r.get("sector_name"),
        "score": _score(r.get("combined_score")),
        "trend": r.get("trend") if r.get("trend") not in (None, "—") else None,
        "quadrant": (daily.get(r.get("sector_name")) or {}).get("quadrant"),
        "returns": perf.get(r.get("sector_name"), {}),
    } for r in ranked[:top_n]]

    return {
        "date": rotation.get("as_of") or report_date.isoformat(),
        "benchmark": rotation.get("benchmark") or "Nifty 50",
        "bench_close": rotation.get("benchmark_close"),
        "bench_returns": rotation.get("benchmark_returns") or {},
        "total": len(results),
        "quadrants": quadrants,
        "confirmed": confirmed,
        "turning_up": sorted(turning_up),
        "cooling": sorted(cooling),
        "moves": moves,
        "board": board,
        "daily": daily,
    }


def _nice_date(s: str) -> str:
    try:
        return date.fromisoformat(str(s)[:10]).strftime("%d %b %Y")
    except ValueError:
        return str(s)


# ── caption (Telegram HTML, max 1024 chars) ──

CAPTION_LIMIT = 1024
NAMES_PER_LINE = 8


def _names(names: list[str], limit: int = NAMES_PER_LINE) -> str:
    """Escaped short names: "A, B, C +5 more"."""
    shown = escape(", ".join(short(n) for n in names[:limit]))
    return shown + (f" +{len(names) - limit} more" if len(names) > limit else "")


def build_caption(d: dict) -> str:
    br = d["bench_returns"]
    head = [f"📊 <b>Sector Rotation</b> · <i>{_nice_date(d['date'])}</i>"]
    if d["bench_close"]:
        head.append(f"{escape(d['benchmark'])} <b>{d['bench_close']:,.0f}</b>  "
                    + " · ".join(f"{k} <code>{_pct(br.get(k))}</code>" for k in ("1D", "1W", "1M")))
    # Each block is one list item, so trimming to fit drops whole blocks and never
    # splits an HTML tag pair.
    blocks = head[:]
    conf = [f"{Q_DOT[q]} <b>{q}</b>: {_names(d['confirmed'][q])}" for q in QUADS if d["confirmed"][q]]
    blocks.append("\n<b>✅ Confirmed on Daily + Weekly</b>\n<blockquote>"
                  + ("\n".join(conf) if conf else "<i>None today: the timeframes disagree, stay selective.</i>")
                  + "</blockquote>")
    turns = []
    if d["turning_up"]:
        turns.append(f"↗ <b>Turning up</b>: {_names(d['turning_up'])}")
    if d["cooling"]:
        turns.append(f"↘ <b>Cooling</b>: {_names(d['cooling'])}")
    if turns:
        blocks.append("<b>🔄 Turns</b>\n<blockquote>" + "\n".join(turns) + "</blockquote>")
    if d["board"]:
        top = " · ".join(f"{escape(short(b['name']))} <code>{b['score']}</code>" for b in d["board"][:3])
        blocks.append(f"🏆 <b>Top momentum</b>: {top}")
    footer = "\n\n👇 <i>Tap a sector for its stocks</i>"
    while len("\n".join(blocks)) + len(footer) > CAPTION_LIMIT and len(blocks) > len(head):
        blocks.pop()
    return "\n".join(blocks).rstrip() + footer


def build_text_report(d: dict) -> str:
    """Fallback when the image can't be rendered: the caption plus every quadrant."""
    lines = [build_caption(d).rsplit("\n\n👇", 1)[0], "", "<b>📍 All sectors (Daily)</b>"]
    for q in QUADS:
        names = d["quadrants"][q]
        lines.append(f"{Q_DOT[q]} <b>{q}</b> ({len(names)}): {_names(names, 30) or '—'}")
    lines.append("\n👇 Tap a sector for its stocks")
    return "\n".join(lines)


# ── image card ──

def render_card(d: dict) -> bytes:
    """Render the report card as a PNG (1080 x 1500 px)."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import FancyBboxPatch, Rectangle

    W, H = 10.8, 15.0
    fig = plt.figure(figsize=(W, H), dpi=100, facecolor=BG)
    font = {"family": "DejaVu Sans"}

    def card(x, y, w, h):
        fig.patches.append(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=0.012",
                                          transform=fig.transFigure, facecolor=CARD, edgecolor=STROKE,
                                          linewidth=1.2, zorder=-1))

    def t(x, y, s, size=12, color=TEXT, weight="normal", ha="left", va="baseline", **kw):
        return fig.text(x, y, s, fontsize=size, color=color, fontweight=weight, ha=ha, va=va, **font, **kw)

    # Header
    t(0.05, 0.962, "SECTOR ROTATION", 11, ACCENT, "bold")
    t(0.05, 0.935, "Where the money is moving", 24, TEXT, "bold")
    br = d["bench_returns"]
    sub = f"{d['benchmark']} vs sectors  ·  data as of {_nice_date(d['date'])}"
    t(0.05, 0.915, sub, 11, MUTED)
    if d["bench_close"]:
        t(0.95, 0.937, f"{d['bench_close']:,.0f}", 22, TEXT, "bold", ha="right")
        chunks = [("1D", br.get("1D")), ("1W", br.get("1W")), ("1M", br.get("1M"))]
        x = 0.95
        for label, v in reversed(chunks):
            s = f"{label} {_pct(v)}"
            t(x, 0.915, s, 11, MUTED if v is None else (UP if v >= 0 else DOWN), "bold", ha="right")
            x -= 0.012 * len(s) + 0.012

    # Quadrant tiles (Daily counts; confirmed names first, marked ✓)
    tile_w, gap, y0, th = 0.2125, 0.0125, 0.735, 0.155
    for i, q in enumerate(QUADS):
        x = 0.05 + i * (tile_w + gap)
        card(x, y0, tile_w, th)
        fig.patches.append(Rectangle((x + 0.012, y0 + th - 0.012), 0.012, 0.004, transform=fig.transFigure,
                                     facecolor=Q_COLOR[q], edgecolor="none"))
        t(x + 0.03, y0 + th - 0.016, q.upper(), 10, Q_COLOR[q], "bold")
        t(x + tile_w - 0.015, y0 + th - 0.04, str(len(d["quadrants"][q])), 22, TEXT, "bold", ha="right")
        t(x + 0.012, y0 + th - 0.038, Q_HINT[q], 8.5, FAINT)
        conf = set(d["confirmed"][q])
        names = sorted(d["quadrants"][q], key=lambda n: n not in conf)
        yy = y0 + th - 0.062
        for n in names[:6]:
            mark = "✓ " if n in conf else "   "
            t(x + 0.012, yy, f"{mark}{short(n)}"[:24], 9.5, TEXT if n in conf else MUTED,
              "bold" if n in conf else "normal")
            yy -= 0.0145
        if len(names) > 6:
            t(x + 0.012, yy, f"+{len(names) - 6} more", 8.5, FAINT)
    t(0.05, y0 - 0.016, "✓ = same quadrant on Daily and Weekly (confirmed)", 9, FAINT)

    # Turns: trend label and rotation disagree on both timeframes
    ty = 0.698
    for label, names, color in (("↗ Turning up", d["turning_up"], Q_COLOR["Improving"]),
                                ("↘ Cooling", d["cooling"], Q_COLOR["Weakening"])):
        if names:
            t(0.05, ty, label, 10.5, color, "bold")
            t(0.19, ty, ", ".join(short(n) for n in names)[:95], 10.5, TEXT)
            ty -= 0.017

    # Rotation map
    card(0.05, 0.345, 0.9, 0.315)
    t(0.07, 0.638, "Rotation map · Daily", 13, TEXT, "bold")
    t(0.07, 0.622, "RS-Ratio (trend) vs RS-Momentum · tails show the last 4 sessions", 9, MUTED)
    ax = fig.add_axes([0.11, 0.38, 0.81, 0.23], facecolor=CARD)
    pts = [(n, r["trail"]) for n, r in d["daily"].items() if r.get("trail")]
    xs = [p["ratio"] for _, tr in pts for p in tr[-5:]] or [100]
    ys = [p["momentum"] for _, tr in pts for p in tr[-5:]] or [100]
    rx = max(1.0, max(abs(v - 100) for v in xs)) * 1.15
    ry = max(1.0, max(abs(v - 100) for v in ys)) * 1.15
    ax.set_xlim(100 - rx, 100 + rx)
    ax.set_ylim(100 - ry, 100 + ry)
    for (x0, y0_), q in [((100, 100), "Leading"), ((100 - rx, 100), "Improving"),
                         ((100 - rx, 100 - ry), "Lagging"), ((100, 100 - ry), "Weakening")]:
        ax.add_patch(Rectangle((x0, y0_), rx, ry, facecolor=Q_COLOR[q], alpha=0.07, edgecolor="none", zorder=0))
    corner = {"Leading": (0.98, 0.97, "right", "top"), "Improving": (0.02, 0.97, "left", "top"),
              "Lagging": (0.02, 0.03, "left", "bottom"), "Weakening": (0.98, 0.03, "right", "bottom")}
    for q, (cx, cy, ha, va) in corner.items():
        ax.text(cx, cy, q.upper(), transform=ax.transAxes, ha=ha, va=va, fontsize=9, color=Q_COLOR[q],
                fontweight="bold", alpha=0.85, **font)
    ax.axhline(100, color=STROKE, lw=1, zorder=1)
    ax.axvline(100, color=STROKE, lw=1, zorder=1)
    for side in ax.spines.values():
        side.set_visible(False)
    ax.tick_params(colors=FAINT, labelsize=8, length=0)
    ax.grid(color=STROKE, lw=0.5, alpha=0.6)
    ax.set_xlabel("RS-Ratio →", color=FAINT, fontsize=9, **font)
    ax.set_ylabel("RS-Momentum →", color=FAINT, fontsize=9, **font)
    labels = []
    for name, tr in pts:
        tail = tr[-4:]
        q = d["daily"][name]["quadrant"]
        c = Q_COLOR.get(q, MUTED)
        ax.plot([p["ratio"] for p in tail], [p["momentum"] for p in tail], color=c, lw=1.2, alpha=0.4,
                solid_capstyle="round", zorder=2)
        last = tail[-1]
        ax.scatter([last["ratio"]], [last["momentum"]], s=46, color=c, edgecolor=BG, linewidth=1.2, zorder=3)
        dist = ((last["ratio"] - 100) ** 2 + (last["momentum"] - 100) ** 2) ** 0.5
        labels.append((dist, ax.annotate(short(name), (last["ratio"], last["momentum"]), xytext=(6, 4),
                                         textcoords="offset points", fontsize=8.5, color=TEXT, zorder=4, **font)))
    # Hide labels that collide, keeping the ones furthest from the centre.
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    kept = []
    for _, lab in sorted(labels, key=lambda x: -x[0]):
        box = lab.get_window_extent(renderer).expanded(1.04, 1.15)
        if any(box.overlaps(k) for k in kept):
            lab.set_visible(False)
        else:
            kept.append(box)

    # Leaderboard
    rows = d["board"]
    card(0.05, 0.035, 0.9, 0.29)
    t(0.07, 0.3, "Momentum leaderboard", 13, TEXT, "bold")
    t(0.07, 0.284, "Score = relative strength + price action (0–100)", 9, MUTED)
    cols = {"name": 0.07, "bar": 0.33, "score": 0.53, "trend": 0.57, "1D": 0.75, "1W": 0.83, "1M": 0.92}
    hy = 0.262
    for key, label in [("name", "SECTOR"), ("score", "SCORE"), ("trend", "TREND"), ("1D", "1D"), ("1W", "1W"), ("1M", "1M")]:
        t(cols[key], hy, label, 8.5, FAINT, "bold", ha="right" if key in ("1D", "1W", "1M", "score") else "left")
    row_h = 0.0255
    for i, b in enumerate(rows):
        y = hy - 0.024 - i * row_h
        q = b["quadrant"]
        if q:
            fig.patches.append(Rectangle((0.06, y - 0.002), 0.003, 0.013, transform=fig.transFigure,
                                         facecolor=Q_COLOR[q], edgecolor="none"))
        t(cols["name"], y, f"{i + 1}  {short(b['name'])}"[:26], 11, TEXT, "bold")
        fig.patches.append(Rectangle((cols["bar"], y + 0.001), 0.16, 0.008, transform=fig.transFigure,
                                     facecolor=STROKE, edgecolor="none"))
        sc = max(0, min(100, b["score"]))
        bc = "#22c55e" if sc >= 65 else "#f59e0b" if sc >= 45 else "#f43f5e"
        fig.patches.append(Rectangle((cols["bar"], y + 0.001), 0.16 * sc / 100, 0.008, transform=fig.transFigure,
                                     facecolor=bc, edgecolor="none"))
        t(cols["score"], y, str(b["score"]), 11, TEXT, "bold", ha="right")
        if b["trend"]:
            t(cols["trend"], y, b["trend"], 10, TREND_COLOR.get(b["trend"], MUTED), "bold")
        for k in ("1D", "1W", "1M"):
            v = b["returns"].get(k)
            t(cols[k], y, _pct(v), 10, MUTED if v is None else (UP if v >= 0 else DOWN), ha="right")
    t(0.95, 0.012, "Illusion · sector rotation", 8.5, FAINT, ha="right")

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=100, facecolor=BG)
    plt.close(fig)
    return buf.getvalue()


# ── sector drill-down (sent when a sector button is tapped) ──

MESSAGE_LIMIT = 4096
DHAN_TV_URL = "https://tv.dhan.co/"
_SIGNAL_LABEL = {"explosion": "Breakout", "vcp": "VCP", "ce": "CE", "pe": "PE"}


def _signal_text(s: dict) -> str:
    raw = str(s.get("signal_type") or "").strip()
    label = _SIGNAL_LABEL.get(raw.lower(), raw.upper()[:10] or "Signal")
    score = s.get("signal_score")
    return f"{label} {round(float(score) * 100) if score is not None and float(score) <= 1 else score}" \
        if score is not None else label


def _company(s: dict, width: int = 28) -> str:
    name = str(s.get("display_name") or s.get("company") or "")
    for junk in (" Limited", " Ltd.", " Ltd"):
        name = name.replace(junk, "")
    return name if len(name) <= width else name[: width - 1] + "…"


def build_sector_drilldown(payload: dict, stats: Optional[dict] = None) -> tuple[str, dict]:
    """
    Rich HTML message for one sector: rotation + score header, then its stocks in
    expandable quotes (signals, F&O with lot sizes, cash-only, not on Dhan), plus
    buttons to open TradingView on Dhan and copy the F&O symbols.
    """
    stats = stats or {}
    sector = payload.get("sector") or "Sector"
    stocks = payload.get("stocks") or []
    dq, wq = stats.get("daily_quadrant"), stats.get("weekly_quadrant")
    dot = Q_DOT.get(dq, "📌")

    head = [f"{dot} <b>{escape(sector)}</b>"]
    if dq or wq:
        conf = "  ✅ <i>confirmed</i>" if dq and dq == wq else ""
        head.append(f"<i>Daily: {dq or '—'} · Weekly: {wq or '—'}</i>{conf}")
    facts = []
    if stats.get("score") is not None:
        facts.append(f"Score <b>{stats['score']}</b>/100")
    if stats.get("trend"):
        facts.append(f"Trend <b>{escape(stats['trend'])}</b>")
    if stats.get("turn"):
        facts.append(escape(stats["turn"]))
    if facts:
        head.append(" · ".join(facts))
    ret = stats.get("returns") or {}
    if ret:
        head.append("Returns  " + " · ".join(f"{k} <code>{_pct(ret.get(k))}</code>" for k in ("1D", "1W", "1M", "3M")
                                             if k in ret))

    signals = [s for s in stocks if s.get("has_signal")]
    fno = [s for s in stocks if s.get("is_fno") and not s.get("has_signal")]
    cash = [s for s in stocks if s.get("in_dhan") and not s.get("is_fno") and not s.get("has_signal")]
    missing = [s for s in stocks if not s.get("in_dhan")]
    head += ["", f"📦 <b>{len(stocks)} stocks</b> · {payload.get('fno_count', len(fno))} F&amp;O · "
                 f"{len(signals)} with signals"]

    def section(title: str, items: list[dict], line, expandable: bool = True) -> list[str]:
        if not items:
            return []
        tag = "<blockquote expandable>" if expandable else "<blockquote>"
        return ["", f"{title} ({len(items)})", tag + "\n".join(line(s) for s in items) + "</blockquote>"]

    sig_line = lambda s: (f"⚡ <b>{escape(s['symbol'])}</b> · {escape(_signal_text(s))}"  # noqa: E731
                          + (f" · lot <code>{s['lot_size']}</code>" if (s.get("lot_size") or 0) > 1 else ""))
    fno_line = lambda s: (f"<b>{escape(s['symbol'])}</b> · {escape(_company(s))}"  # noqa: E731
                          + (f" · lot <code>{s['lot_size']}</code>" if (s.get("lot_size") or 0) > 1 else ""))
    cash_line = lambda s: f"<b>{escape(s['symbol'])}</b> · {escape(_company(s))}"  # noqa: E731

    foot = []
    if payload.get("as_of"):
        foot = ["", f"<i>NSE constituents as of {escape(_nice_date(payload['as_of']))}</i>"]

    def assemble(cap: int) -> str:
        """Lists are cut to `cap` lines each ("+N more") so the message fits Telegram's limit."""
        def cut(items):
            return items[:cap]
        body = []
        body += section("⚡ <b>Active signals</b>", cut(signals), sig_line, expandable=False)
        body += section("📈 <b>F&amp;O stocks</b>", cut(fno), fno_line, expandable=len(fno) > 6)
        body += section("💵 <b>Cash only</b>", cut(cash), cash_line)
        body += section("⛔ <b>Not on Dhan</b>", cut(missing), cash_line)
        text = "\n".join(head + body + foot)
        hidden = sum(max(0, len(g) - cap) for g in (signals, fno, cash, missing))
        if hidden:
            text += f"\n<i>+{hidden} more not shown, see the Sectors tab</i>"
        return text

    cap = max(len(signals), len(fno), len(cash), len(missing), 1)
    text = assemble(cap)
    while len(text) > MESSAGE_LIMIT and cap > 5:
        cap = max(5, int(cap * 0.8))
        text = assemble(cap)

    buttons = [[{"text": "📈 Open TradingView on Dhan", "url": DHAN_TV_URL}]]
    fno_syms = ",".join(s["symbol"] for s in signals + fno if s.get("is_fno"))
    if fno_syms:
        if len(fno_syms) > 256:  # Telegram's copy_text limit: cut at a comma, never mid-symbol
            fno_syms = fno_syms[:256].rsplit(",", 1)[0]
        buttons.append([{"text": "📋 Copy F&O symbols", "copy_text": {"text": fno_syms}}])
    return text, {"inline_keyboard": buttons}
