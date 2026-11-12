"""
Telegram image card for one swing setup: clean candlestick chart with the plan levels,
the trade plan, why it qualifies, warnings and the score breakdown.

Rendered with Matplotlib's object API (no pyplot global state, safe in a worker thread)
at 1600 x 2000 px, below Telegram's 2560 px photo limit so it is barely resampled.
"""

from __future__ import annotations

import io
import textwrap
from datetime import datetime
from html import escape
from typing import Optional

BG = "#0b1220"
CARD = "#121b2e"
STROKE = "#1f2a44"
TEXT = "#e2e8f0"
MUTED = "#94a3b8"
FAINT = "#64748b"
ACCENT = "#818cf8"
UP, DOWN = "#22c55e", "#f43f5e"
AMBER = "#fbbf24"
SETUP_COLOR = {"VCP": "#a78bfa", "FLAG": "#22d3ee", "IPO": "#fb923c"}
SETUP_NAME = {"VCP": "VCP", "FLAG": "Bull flag", "IPO": "IPO base"}
STATUS = {"triggered": ("Breakout today", UP), "ready": ("Ready", ACCENT),
          "forming": ("Forming", "#fde047"), "extended": ("Extended", AMBER)}
TIER_COLOR = {"A+": UP, "A": UP, "B": ACCENT, "C": MUTED}
COMP = [("pattern", "Pattern"), ("trend", "Trend"), ("rs", "Rel. strength"),
        ("sector", "Sector"), ("smart_money", "Smart money"), ("risk", "Risk / room")]
FONT = "DejaVu Sans"


def _rs(v: Optional[float]) -> str:
    if v is None:
        return "—"
    return f"₹{v:,.2f}" if v < 1000 else f"₹{v:,.1f}" if v < 10000 else f"₹{v:,.0f}"


def _inr(v: Optional[float]) -> str:
    return "—" if v is None else f"₹{v:,.0f}"


def _status_label(s: dict) -> str:
    st = s.get("status")
    if st == "triggered" and (s.get("breakout_age") or 0) > 0:
        return f"Breakout · day {s['breakout_age'] + 1}"
    return STATUS.get(st, (st, MUTED))[0]


def render_setup_card(s: dict, *, regime: Optional[dict] = None, as_of: Optional[str] = None) -> bytes:
    """s = the API's setup_out(full=True) dict. Returns PNG bytes."""
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    from matplotlib.figure import Figure
    from matplotlib.patches import FancyBboxPatch, Rectangle

    W, H, DPI = 8.0, 10.0, 200
    fig = Figure(figsize=(W, H), dpi=DPI, facecolor=BG)
    FigureCanvasAgg(fig)

    def t(x, y, txt, size=10, color=TEXT, weight="normal", ha="left", va="baseline", **kw):
        return fig.text(x, y, txt, fontsize=size, color=color, fontweight=weight, ha=ha, va=va, family=FONT, **kw)

    def panel(x, y, w, h, face=CARD):
        fig.patches.append(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=0.012",
                                          transform=fig.transFigure, facecolor=face, edgecolor=STROKE,
                                          linewidth=0.8, zorder=-1))

    def pill(x, y, txt, color, size=8.5, filled=False, ha="left"):
        return t(x, y, f" {txt} ", size, BG if filled else color, "bold", ha=ha, va="center",
                 bbox=dict(boxstyle="round,pad=0.35,rounding_size=0.8", facecolor=color if filled else BG,
                           edgecolor=color, linewidth=1))

    # ── header ──
    setup = s.get("setup") or ""
    t(0.05, 0.955, s.get("symbol", ""), 24, TEXT, "bold")
    sub = " · ".join(x for x in [s.get("name"), (f"{s['sector']} #{s['sector_rank']}" if s.get("sector_rank") else s.get("sector"))] if x)
    t(0.05, 0.933, sub[:80], 9, MUTED)
    tags_y = 0.912
    x = 0.05
    for txt, col, filled in [(SETUP_NAME.get(setup, setup), SETUP_COLOR.get(setup, ACCENT), False),
                             (f"{s.get('tier')} · {round(s.get('score') or 0)}", TIER_COLOR.get(s.get("tier"), MUTED), s.get("tier") == "A+"),
                             (_status_label(s), STATUS.get(s.get("status"), ("", MUTED))[1], False)] + \
            ([("★ Top pick", AMBER, False)] if s.get("top_pick") else []) + ([("F&O", MUTED, False)] if s.get("is_fno") else []):
        txt_obj = pill(x, tags_y, txt, col, filled=filled)
        bb = txt_obj.get_window_extent(renderer=fig.canvas.get_renderer())
        x += bb.width / (W * DPI) + 0.018
    t(0.95, 0.955, _rs(s.get("close")), 22, TEXT, "bold", ha="right")
    d = s.get("distance_pct")
    if d is not None:
        lbl = f"{abs(d):.1f}% {'below' if d > 0 else 'above'} entry"
        t(0.95, 0.933, lbl, 9, MUTED, ha="right")
    t(0.95, 0.912, f"RS rating {s.get('rs_rating') or '—'}", 9, MUTED, ha="right", va="center")

    # ── chart ──
    rows = s.get("chart") or []
    ax = fig.add_axes([0.07, 0.585, 0.78, 0.29], facecolor=CARD)
    axv = fig.add_axes([0.07, 0.535, 0.78, 0.05], facecolor=CARD, sharex=ax)
    if rows:
        n = len(rows)
        xs = range(n)
        o = [r[1] for r in rows]; h = [r[2] for r in rows]; lo = [r[3] for r in rows]; c = [r[4] for r in rows]
        v = [r[5] for r in rows]
        cols = [UP if c[i] >= o[i] else DOWN for i in xs]
        ax.vlines(list(xs), lo, h, colors=cols, linewidth=0.7)
        ax.bar(list(xs), [abs(c[i] - o[i]) or (h[i] - lo[i]) * 0.02 for i in xs], bottom=[min(o[i], c[i]) for i in xs],
               color=cols, width=0.65, linewidth=0)
        # 50-day average for context (from the visible closes)
        if n >= 50:
            ma = [sum(c[i - 49:i + 1]) / 50 if i >= 49 else None for i in xs]
            ax.plot([i for i in xs if ma[i]], [m for m in ma if m], color=FAINT, linewidth=0.9, alpha=0.9)
        axv.bar(list(xs), v, color=[col + "88" for col in cols], width=0.65, linewidth=0)
        vs = sorted(v)
        cap = vs[int(len(vs) * 0.95)] * 1.6 if vs else 0       # one block deal must not flatten every other bar
        if cap > 0:
            axv.set_ylim(0, cap)
        e, st, t1, t2 = s.get("entry"), s.get("stop"), s.get("target1"), s.get("target2")
        ymin = min(min(lo), st or min(lo)) * 0.985
        ymax = max(max(h), t2 or max(h)) * 1.015
        ax.set_ylim(ymin, ymax)
        ax.set_xlim(-1, n + 1)
        if e and st:
            ax.axhspan(st, e, color=DOWN, alpha=0.07, linewidth=0)
        if e and t2:
            ax.axhspan(e, t2, color=UP, alpha=0.05, linewidth=0)
        ex = s.get("example") or {}

        def money(v):
            return (f"{'+' if v['amount'] >= 0 else '−'}{_inr(abs(v['amount']))}") if v else ""

        tags = [(t2, "T2", UP, "--", money(ex.get("t2"))), (t1, "T1 2R", UP, ":", money(ex.get("t1"))),
                (e, "Entry", ACCENT, "-", f"{ex['qty']} sh" if ex.get("qty") else ""),
                (st, "Stop", DOWN, "-", money(ex.get("stop")))]
        tags = [x for x in tags if x[0]]
        for lvl, _, col, ls, _ in tags:
            ax.axhline(lvl, color=col, linewidth=1.1 if ls == "-" else 0.9, linestyle=ls)
        # two-line tags (price + P&L on the example capital), pushed apart so they never overlap
        span = ymax - ymin
        fr = sorted(((lvl - ymin) / span, i) for i, (lvl, *_r) in enumerate(tags))
        adj, gap = {}, 0.085
        prev = None
        for f, i in reversed(fr):                      # from the top down
            f2 = f if prev is None else min(f, prev - gap)
            adj[i] = f2
            prev = f2
        low = min(adj.values())
        if low < 0.03:
            adj = {i: v + (0.03 - low) for i, v in adj.items()}
        axes_h_pt = 0.29 * H * 72
        for i, (lvl, name, col, ls, sub) in enumerate(tags):
            dy = (adj[i] - (lvl - ymin) / span) * axes_h_pt
            label = f"{name}  {_rs(lvl)}" + (f"\n{sub}" if sub else "")
            ax.annotate(label, xy=(1.0, lvl), xycoords=("axes fraction", "data"), xytext=(6, dy),
                        textcoords="offset points", va="center", ha="left", fontsize=7.6, color=BG, weight="bold",
                        family=FONT, linespacing=1.25,
                        bbox=dict(boxstyle="round,pad=0.3", facecolor=col, edgecolor="none"),
                        arrowprops=dict(arrowstyle="-", color=col, linewidth=0.8, shrinkA=0, shrinkB=0) if abs(dy) > 2 else None,
                        annotation_clip=False)
        t(0.07, 0.882, f"Last {n} sessions" + (f"  ·  tags show P&L on {_inr(ex['capital'])} ({ex['qty']} shares)"
                                                 if ex.get("qty") else ""), 7.5, FAINT)
        ticks = list(range(0, n, max(1, n // 6)))
        axv.set_xticks(ticks)
        axv.set_xticklabels([datetime.strptime(rows[i][0], "%Y-%m-%d").strftime("%d %b") for i in ticks],
                            fontsize=7, color=FAINT, family=FONT)
    for a in (ax, axv):
        for sp in a.spines.values():
            sp.set_color(STROKE)
        a.tick_params(colors=FAINT, labelsize=7, length=0)
        a.grid(axis="y", color=STROKE, linewidth=0.5)
    ax.tick_params(labelbottom=False)
    ax.yaxis.tick_left()
    axv.set_yticks([])
    for lbl in ax.get_yticklabels():
        lbl.set_family(FONT)

    # ── plan strip ──
    py, ph = 0.425, 0.085
    panel(0.05, py, 0.9, ph)
    sz = s.get("sizing") or {}
    cells = [("BUY ABOVE", _rs(s.get("entry")), "", TEXT),
             ("STOP LOSS", _rs(s.get("stop")), f"−{(s.get('risk_pct') or 0):.1f}%", DOWN),
             ("T1 (2R)", _rs(s.get("target1")), "book half", UP),
             ("T2", _rs(s.get("target2")), f"{s.get('rr')}R" if s.get("rr") else "", UP),
             ("QTY", str(sz.get("qty", "—")), _inr(sz.get("position_value")), TEXT),
             ("RISK", _inr(sz.get("risk_amount")), "if stopped", TEXT)]
    cw = 0.9 / len(cells)
    for i, (lab, val, sub2, col) in enumerate(cells):
        cx = 0.05 + cw * i + 0.018
        t(cx, py + ph - 0.022, lab, 7, FAINT, "bold")
        t(cx, py + ph - 0.05, val, 12.5 if len(val) < 10 else 11, col, "bold")
        if sub2:
            t(cx, py + 0.012, sub2, 7.5, MUTED)

    # ── example on a fixed capital ──
    ex = s.get("example") or {}
    y = 0.395
    if ex.get("qty"):
        def seg(label, v):
            return f"{label} {'+' if v['amount'] >= 0 else '−'}{_inr(abs(v['amount']))} ({v['pct']:+.1f}%)" if v else ""
        t(0.05, 0.404, f"EXAMPLE WITH {_inr(ex['capital'])}", 8, ACCENT, "bold")
        t(0.05, 0.382, f"{ex['qty']} shares ({_inr(ex['invested'])})", 9, TEXT, "bold")
        xx = 0.28
        for label, key, col in (("T1", "t1", UP), ("T2", "t2", UP), ("Stop", "stop", DOWN)):
            if ex.get(key):
                txt_obj = t(xx, 0.382, seg(label, ex[key]), 9, col, "bold")
                xx += txt_obj.get_window_extent(renderer=fig.canvas.get_renderer()).width / (W * DPI) + 0.022
        y = 0.35
    tm = s.get("timing") or {}
    if tm.get("t1"):
        def est(label, x):
            return f"{label} ~{x['median']} days ({x['p25']}–{x['p75']})" if x and x.get("median") is not None \
                else f"{label} beyond {tm.get('horizon', 60)} days"
        ty = y - 0.004
        t(0.05, ty, "EST. HOLDING TIME", 8, ACCENT, "bold")
        t(0.30, ty, f"{est('T1', tm['t1'])}     {est('T2', tm.get('t2'))}", 9.5, TEXT, "bold")
        t(0.95, ty, f"baseline T1-before-stop {round(tm['t1']['prob'])}%", 7.5, FAINT, ha="right")
        y = ty - 0.034
    # Space budget: the score block needs everything below SCORE_TOP, and warnings matter more
    # than extra reasons, so reasons stop early enough to leave room for every warning line.
    SCORE_TOP, LINE = 0.135, 0.019
    warn_lines = [(j, line) for w in (s.get("warnings") or [])[:3] for j, line in enumerate(textwrap.wrap(w, 92)[:2])]
    warn_space = (0.028 + LINE * len(warn_lines)) if warn_lines else 0.0
    t(0.05, y, "WHY IT QUALIFIES", 8, ACCENT, "bold")
    y -= 0.022
    for r in (s.get("reasons") or [])[:6]:
        lines = textwrap.wrap(r, 92)[:2]
        if y - LINE * len(lines) < SCORE_TOP + warn_space:
            break
        for j, line in enumerate(lines):
            t(0.05, y, ("✓  " if j == 0 else "    ") + line, 8.6, TEXT)
            y -= LINE
    if warn_lines:
        y -= 0.006
        t(0.05, y, "WATCH OUT", 8, AMBER, "bold")
        y -= 0.022
        for j, line in warn_lines:
            if y < SCORE_TOP - 0.005:
                break
            t(0.05, y, ("⚠  " if j == 0 else "    ") + line, 8.6, AMBER)
            y -= LINE

    # ── score bars ──
    by = max(0.1, min(y - 0.03, 0.2))
    comps = s.get("components") or {}
    t(0.05, by + 0.012, "SCORE BREAKDOWN", 8, ACCENT, "bold")
    for i, (k, lab) in enumerate(COMP):
        col_x = 0.05 + (i % 3) * 0.3
        row_y = by - 0.016 - (i // 3) * 0.022
        val = max(0.0, min(1.0, float(comps.get(k) or 0)))
        t(col_x, row_y, lab, 7.8, MUTED, va="center")
        fig.patches.append(Rectangle((col_x + 0.105, row_y - 0.004), 0.14, 0.008, transform=fig.transFigure,
                                     facecolor=STROKE, edgecolor="none"))
        fig.patches.append(Rectangle((col_x + 0.105, row_y - 0.004), 0.14 * val, 0.008, transform=fig.transFigure,
                                     facecolor=ACCENT, edgecolor="none"))
        t(col_x + 0.255, row_y, f"{round(val * 100)}", 7.8, TEXT, "bold", va="center")

    # ── footer ──
    reg = (regime or {}).get("label")
    foot = f"Market {reg.upper()}" if reg else ""
    if as_of:
        foot += ("  ·  " if foot else "") + f"data as of {as_of}"
    t(0.05, 0.022, foot, 7.5, FAINT)
    t(0.95, 0.022, "Illusion · swing setup · not investment advice", 7.5, FAINT, ha="right")

    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=DPI, facecolor=BG)
    return buf.getvalue()


CAPTION_SETUP = {"VCP": "VCP based", "FLAG": "Flag based", "IPO": "IPO based"}


def build_caption(s: dict) -> str:
    """One-line caption; everything else is on the image."""
    kind = CAPTION_SETUP.get(s.get("setup"), f"{s.get('setup') or 'Setup'} based")
    return f"AI Based Analysis - Swing Setups ({escape(kind)})"
