"""
TechnoFunda — business profile and "story in numbers".

build_business() combines what the company says about itself (Screener about / key points), an
encyclopaedic overview (Wikipedia + Wikidata facts), the latest annual-report digest (Tapetide), the
peer table (Screener) and the company's own 10-year numbers into one structure for the UI:

  overview      short "what the company does" text for the Summary tab
  facts         founded, headquarters, founders, industry, employees, listed since, website
  revenue_mix   segment / vertical split when the company publishes one
  key_points    Screener's public key points
  story         deterministic narrative paragraphs written from the financials (no LLM)
  annual_report digest sections + source links
  peers         comparison table + where the company stands

Pure functions, no I/O.
"""

from __future__ import annotations

import statistics
from typing import Any, Optional

from backend.services.techno_funda_fundamental import _period_key, cagr, series
from backend.services.techno_funda_sources import parse_revenue_mix


def _cr(v: Optional[float]) -> str:
    """Indian-style crore amount: ₹1,23,456 Cr / ₹2.83 L Cr."""
    if v is None:
        return "n/a"
    if abs(v) >= 100000:
        return f"₹{v / 100000:,.2f} lakh crore"
    s = f"{abs(v):,.0f}"
    # re-group to Indian digits: last 3, then pairs
    digits = s.replace(",", "")
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        pairs = []
        while len(head) > 2:
            pairs.insert(0, head[-2:])
            head = head[:-2]
        s = ",".join(([head] if head else []) + pairs + [tail])
    return f"{'−' if v < 0 else ''}₹{s} crore"


def _pct(v: Optional[float], nd: int = 0, signed: bool = False) -> str:
    if v is None:
        return "n/a"
    return f"{v:+.{nd}f}%" if signed else f"{v:.{nd}f}%"


def _change(pct: Optional[float], noun: str) -> str:
    """'+12825%' reads as noise; describe big moves in words."""
    if pct is None:
        return f"{noun} is not comparable"
    if pct >= 300:
        return f"{noun} jumped many-fold from a very small base"
    if pct >= 100:
        return f"{noun} rose {pct / 100 + 1:.1f}× (off a low base)"
    if pct <= -90:
        return f"{noun} almost disappeared ({pct:+.0f}%)"
    return f"{noun} changed {pct:+.1f}%"


def _a(word: str) -> str:
    return "an" if (word or "x")[0].lower() in "aeiou" else "a"


def _clean_ws(t: Optional[str]) -> Optional[str]:
    import re

    return re.sub(r"\s+", " ", t).strip() if t else t


def _first_sentences(text: str, n: int = 2, limit: int = 420) -> str:
    import re

    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z])", (text or "").strip())
    out = " ".join(parts[:n]).strip()
    return out if len(out) <= limit else out[: limit - 1].rsplit(" ", 1)[0] + "…"


def build_business(raw: dict[str, Any], fund: dict[str, Any]) -> dict[str, Any]:
    prof = ((raw.get("profile") or {}).get("data")) or {}
    company = prof.get("company") or {}
    fc = fund.get("company") or {}
    wiki = raw.get("wiki") or None
    ar = raw.get("annual_report") or None
    name = fc.get("name") or company.get("name") or "The company"
    short = name.replace(" Ltd", "").replace(" Limited", "")

    about = company.get("about") or fc.get("about")
    key_points = [k for k in (company.get("key_points") or []) if k]
    mix = parse_revenue_mix(key_points)

    # ── overview for the Summary tab ──
    exec_overview = None
    ar_secs = (ar or {}).get("sections") or []
    pick = next((sec for sec in ar_secs if any(w in sec["heading"].lower() for w in ("overview", "summary", "highlights"))),
                ar_secs[0] if ar_secs else None)
    if pick:
        body = " ".join(ln.lstrip("-*• ").strip() for ln in pick["body"].replace("**", "").splitlines() if ln.strip())
        exec_overview = _first_sentences(body, n=3, limit=650)
    overview = {
        "identity": (wiki or {}).get("description"),
        "about": about or _first_sentences((wiki or {}).get("extract", ""), n=3),
        "wiki_intro": _first_sentences((wiki or {}).get("extract", ""), n=2) if wiki and about else None,
        "latest": exec_overview,
        "latest_period": (ar or {}).get("period"),
    }

    # ── facts ──
    wf = (wiki or {}).get("facts") or {}
    facts = {
        "Founded": ", ".join(wf.get("founded", [])) or None,
        "Headquarters": ", ".join(wf.get("headquarters", [])) or None,
        "Founders": ", ".join(wf.get("founders", [])) or None,
        "Industry": ", ".join(wf.get("industry", [])[:3]) or " › ".join(dict.fromkeys(
            _clean_ws(x) for x in (fc.get("sector"), fc.get("industry"), fc.get("basic_industry")) if x)) or None,
        "Employees": f"{int(float(wf['employees'][0])):,}" if wf.get("employees") and str(wf["employees"][0]).replace(".", "").isdigit() else (f"{fc['employees']:,}" if fc.get("employees") else None),
        "Parent / group": ", ".join(wf.get("parent", [])) or None,
        "CEO": fc.get("ceo"),
        "Listed since": fc.get("listing_date"),
        "Website": fc.get("website") or company.get("website"),
    }
    facts = {k: v for k, v in facts.items() if v}

    peers_block = _peers(raw.get("peers") or [], fc.get("symbol") or company.get("nse_symbol"), name, fund)

    return {
        "available": bool(about or wiki or ar or key_points),
        "overview": overview,
        "facts": facts,
        "revenue_mix": mix,
        "key_points": [] if mix and len(key_points) <= len(mix["items"]) + 1 else key_points,
        "story": _story(short, raw, fund, peers_block),
        "annual_report": ar,
        "wiki": ({"title": wiki.get("title"), "url": wiki.get("url"), "extract": wiki.get("extract")} if wiki else None),
        "peers": peers_block,
    }


# ───────────────────────── peers ─────────────────────────

def _peers(rows: list[dict], symbol: Optional[str], name: str, fund: dict) -> Optional[dict]:
    if not rows:
        return None
    sym = (symbol or "").upper()
    first_word = (name.split() or [""])[0].lower()
    for r in rows:
        r["is_self"] = bool((r.get("symbol") or "").upper() == sym or (not sym and first_word and r["name"].lower().startswith(first_word)))
    if not any(r["is_self"] for r in rows):
        # Screener lists the company itself first when its symbol isn't in the link (e.g. BSE-only)
        rows[0]["is_self"] = rows[0]["name"].lower().split()[0] == first_word
    self_row = next((r for r in rows if r["is_self"]), None)
    others = [r for r in rows if not r["is_self"]]

    def med(key):
        vals = [r[key] for r in others if r.get(key) is not None]
        return statistics.median(vals) if vals else None

    position = {
        "peer_count": len(others),
        "rank_by_market_cap": (sorted(rows, key=lambda r: -(r.get("market_cap") or 0)).index(self_row) + 1) if self_row else None,
        "median_pe": med("pe"), "median_roce": med("roce"),
        "median_qtr_sales_var": med("qtr_sales_var"), "median_qtr_profit_var": med("qtr_profit_var"),
    }
    return {"rows": rows, "self": self_row, "position": position}


# ───────────────────────── story ─────────────────────────

def _story(short: str, raw: dict, fund: dict, peers: Optional[dict]) -> list[dict]:
    """Plain-English paragraphs written from the numbers. Each section only appears when its data exists."""
    pl, bs, cf = raw.get("profit_loss"), raw.get("balance_sheet"), raw.get("cash_flow")
    g, q, h, v, o = (fund.get(k) or {} for k in ("growth", "quality", "financial_health", "valuation", "ownership"))
    fc = fund.get("company") or {}
    out: list[dict] = []

    sales_all = series(pl, "Sales", include_ttm=True)
    np_all = series(pl, "Net Profit", include_ttm=True)
    sales = [x for x in sales_all if x[0] != "TTM"]
    npf = [x for x in np_all if x[0] != "TTM"]
    ttm_sales = next((val for p, val in sales_all if p == "TTM"), sales[-1][1] if sales else None)
    ttm_np = next((val for p, val in np_all if p == "TTM"), npf[-1][1] if npf else None)

    # 1. Scale
    if ttm_sales:
        cls = (fc.get("classification") or "").lower()
        ind = _clean_ws(fc.get("industry") or fc.get("sector") or "listed")
        size = f"{_a(cls)} {cls} " if cls else f"{_a(ind)} "
        mcap = v.get("market_cap_cr")
        txt = (f"{short} is {size}{ind} company"
               + (f" valued at about {_cr(mcap)} on the stock market" if mcap else "")
               + f". Over the last twelve months it reported revenue of {_cr(ttm_sales)}")
        if ttm_np is not None:
            margin = ttm_np / ttm_sales * 100 if ttm_sales else None
            txt += (f" and a net profit of {_cr(ttm_np)} (keeping about ₹{margin:.0f} of every ₹100 of sales as profit)."
                    if ttm_np > 0 and margin is not None else f" and a net loss of {_cr(abs(ttm_np))}.")
        else:
            txt += "."
        out.append({"title": "How big is the business?", "text": txt})

    # 2. Growth arc
    if len(sales) >= 4:
        first_p, first_v = sales[0]
        yrs = (_period_key(sales[-1][0]).year - _period_key(first_p).year) or (len(sales) - 1)
        long_cagr = cagr(first_v, sales[-1][1], yrs)
        s3 = (g.get("sales_cagr") or {}).get("3 Years")
        yoy = [(sales[i][0], (sales[i][1] / sales[i - 1][1] - 1) * 100) for i in range(1, len(sales)) if sales[i - 1][1]]
        best = max(yoy, key=lambda x: x[1]) if yoy else None
        worst = min(yoy, key=lambda x: x[1]) if yoy else None
        txt = f"Revenue went from {_cr(first_v)} in {first_p} to {_cr(sales[-1][1])} in {sales[-1][0]}"
        if long_cagr is not None:
            txt += f", compounding at about {long_cagr:.0f}% a year over {yrs} years"
        txt += "."
        if s3 is not None and long_cagr is not None:
            if s3 < 0:
                txt += f" Revenue has shrunk over the last 3 years ({s3:.0f}% a year)."
            elif s3 < long_cagr - 3:
                txt += f" Growth has slowed recently: the last 3 years averaged {s3:.0f}% a year."
            elif s3 > long_cagr + 3:
                txt += f" Growth has picked up recently: the last 3 years averaged {s3:.0f}% a year."
            else:
                txt += f" The last 3 years ({s3:.0f}% a year) are in line with that long-run pace."
        if best and worst and best[0] != worst[0]:
            txt += f" Its best year was {best[0]} ({best[1]:+.0f}%) and its weakest {worst[0]} ({worst[1]:+.0f}%)."
        out.append({"title": "How has it grown?", "text": txt})

    # 3. Profit quality and margins
    opm = [val for _, val in series(pl, "OPM %")]
    if len(npf) >= 4:
        losses = [p for p, val in npf if val < 0]
        p_cagr = cagr(npf[0][1], npf[-1][1], len(npf) - 1) if npf[0][1] > 0 and npf[-1][1] > 0 else None
        txt = ""
        if p_cagr is not None:
            txt += f"Net profit compounded at about {p_cagr:.0f}% a year from {npf[0][0]} to {npf[-1][0]}. "
        txt += (f"It made a loss in {len(losses)} of the last {len(npf)} years ({', '.join(losses[-3:])}). " if losses
                else f"It has been profitable in every one of the last {len(npf)} years. ")
        if len(opm) >= 4:
            txt += (f"Operating margin has ranged between {min(opm):.0f}% and {max(opm):.0f}%, and was {opm[-1]:.0f}% in the latest year"
                    + (", near the top of its range." if opm[-1] >= max(opm) - 1 else ", near the bottom of its range." if opm[-1] <= min(opm) + 1 else "."))
        roce5 = q.get("roce_5y_avg")
        if roce5 is not None and not h.get("is_financial"):
            verdict = ("an excellent return that usually signals a strong competitive position" if roce5 >= 25
                       else "a healthy return" if roce5 >= 15 else "a modest return, below what good businesses usually earn")
            txt += f" Over 5 years it earned an average {roce5:.0f}% on all the capital it used (ROCE), {verdict}."
        out.append({"title": "Does it make good money?", "text": txt.strip()})

    # 4. Cash and debt
    cfo = series(cf, "Cash from Operating Activity")
    fcf = series(cf, "Free Cash Flow")
    bor = series(bs, "Borrowings")
    if cfo or bor:
        parts = []
        conv = q.get("cash_conversion_5y")
        if fcf:
            tot = sum(val for _, val in fcf[-5:])
            parts.append(f"In the last {min(5, len(fcf))} years it generated {_cr(tot)} of free cash flow (cash left after running and expanding the business)")
        if conv is not None and 0 < conv <= 3:
            parts.append(f"and turned {conv * 100:.0f}% of its reported profit into operating cash" if fcf
                         else f"It turned {conv * 100:.0f}% of its reported profit into operating cash")
        elif conv is not None and conv > 3:
            parts.append("and its operating cash flow was far larger than its (small) reported profit" if fcf
                         else "Its operating cash flow was far larger than its (small) reported profit")
        txt = (" ".join(parts) + ".") if parts else ""
        if h.get("is_financial"):
            txt += " As a lender, borrowing (deposits and bonds) is its raw material, so debt is judged differently."
        elif bor:
            de = h.get("debt_to_equity")
            if bor[-1][1] <= 1 or (de is not None and de < 0.05):
                txt += " It is practically debt-free."
            else:
                trend = "rising" if len(bor) >= 4 and bor[-1][1] > bor[-4][1] * 1.2 else "falling" if len(bor) >= 4 and bor[-1][1] < bor[-4][1] * 0.8 else "broadly stable"
                txt += f" Borrowings stand at {_cr(bor[-1][1])} (debt-to-equity {de if de is not None else 'n/a'}), {trend} over the last 3 years."
        payout = q.get("dividend_payout_pct")
        dil = h.get("equity_change_3y_pct")
        if payout:
            txt += f" It paid out about {payout:.0f}% of last year's profit as dividends."
        if dil is not None and dil < -0.5:
            txt += " Its share count has fallen, a sign of buybacks."
        elif dil is not None and dil > 5:
            txt += f" Its share capital rose {dil:.0f}% in 3 years (new shares, a bonus issue or a merger)."
        if txt.strip():
            out.append({"title": "Cash, debt and what it does with the money", "text": txt.strip()})

    # 5. Ownership
    if o.get("promoter") is not None or o.get("institutional") is not None:
        txt = ""
        if o.get("promoter"):
            txt += f"The promoter group owns {o['promoter']:.1f}% of the company"
            ch = o.get("promoter_change_1y")
            txt += (f", {'up' if ch > 0 else 'down'} {abs(ch):.1f} points in a year" if ch not in (None, 0) and abs(ch) >= 0.1 else ", unchanged over the year")
            pl_pct = o.get("pledge_pct")
            txt += (f", with {pl_pct:.0f}% of that stake pledged to lenders." if pl_pct else ", with none of it pledged." if pl_pct == 0 else ".")
        elif o.get("promoter") == 0 or o.get("promoter") is None:
            txt += "There is no promoter group: the company is widely held."
        if o.get("institutional") is not None:
            ch = o.get("institutional_change_1y")
            txt += f" Foreign and domestic institutions together hold {o['institutional']:.1f}%" + (
                f", {'adding' if ch > 0 else 'trimming'} {abs(ch):.1f} points over the past year." if ch else ".")
        out.append({"title": "Who owns it?", "text": txt.strip()})

    # 6. Latest quarter
    if g.get("latest_quarter") and (g.get("sales_yoy_q") is not None or g.get("profit_yoy_q") is not None):
        txt = (f"In the {g['latest_quarter']} quarter, {_change(g.get('sales_yoy_q'), 'sales')} and "
               f"{_change(g.get('profit_yoy_q'), 'net profit')} compared with the same quarter a year earlier.")
        if g.get("opm_change_4q_vs_prior_4q") is not None:
            d = g["opm_change_4q_vs_prior_4q"]
            txt += f" Margins over the last four quarters are {abs(d):.1f} points {'higher' if d >= 0 else 'lower'} than the four before."
        out.append({"title": "What happened most recently?", "text": txt})

    # 7. Versus peers
    if peers and peers.get("self"):
        me, pos = peers["self"], peers["position"]
        txt = f"Among {pos['peer_count'] + 1} listed companies in its industry group, it is number {pos['rank_by_market_cap']} by market value."
        if me.get("pe") and pos.get("median_pe"):
            rel = "cheaper than" if me["pe"] < pos["median_pe"] * 0.9 else "pricier than" if me["pe"] > pos["median_pe"] * 1.1 else "in line with"
            txt += f" At {me['pe']:.0f}× earnings it trades {rel} the peer median ({pos['median_pe']:.0f}×)."
        if me.get("roce") and pos.get("median_roce"):
            txt += f" Its ROCE of {me['roce']:.0f}% compares with a peer median of {pos['median_roce']:.0f}%."
        if me.get("qtr_sales_var") is not None and pos.get("median_qtr_sales_var") is not None:
            txt += f" Last quarter its sales grew {me['qtr_sales_var']:+.0f}% versus {pos['median_qtr_sales_var']:+.0f}% for the median peer."
        out.append({"title": "How does it compare with rivals?", "text": txt})

    return out
