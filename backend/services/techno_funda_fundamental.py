"""
TechnoFunda — fundamental analysis engine.

Works on raw Tapetide MCP responses (profile, statements, shareholding, forecasts, pledge,
deals, concall digest, …) and turns them into five scored pillars plus a checklist,
red/green flags and valuation models. No I/O here: the service layer fetches the data.

Statement payloads look like:
    {"data": [{"periods": [...], "data": {"Sales": {"Mar 2024": 123, ...}, ...}}]}
Amounts are ₹ crore unless a row is a %.
"""

from __future__ import annotations

import math
import re
import statistics
from datetime import datetime
from typing import Any, Optional

FUND_WEIGHTS = {"quality": 30, "growth": 25, "financial_health": 20, "valuation": 15, "ownership": 10}
FINANCIAL_SECTOR_HINTS = ("bank", "nbfc", "finance", "financial", "insurance", "housing finance", "capital markets")


# ───────────────────────── parsing helpers ─────────────────────────

def _num(v: Any) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, str):
        v = v.replace("%", "").replace(",", "").strip()
        if not v:
            return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(x) or math.isinf(x) else x


def _r(v: Optional[float], nd: int = 2) -> Optional[float]:
    return None if v is None else round(v, nd)


def _period_key(p: str) -> datetime:
    if p == "TTM":
        return datetime(9999, 1, 1)
    for fmt in ("%b %Y", "%Y-%m-%d", "%Y%m"):
        try:
            return datetime.strptime(p, fmt)
        except ValueError:
            continue
    return datetime(1900, 1, 1)


def _block(resp: Any) -> dict:
    """First statement block from a get_financials / get_shareholding response."""
    if not isinstance(resp, dict):
        return {}
    data = resp.get("data")
    if isinstance(data, list) and data:
        return data[0] if isinstance(data[0], dict) else {}
    return data if isinstance(data, dict) else {}


def series(resp: Any, row: str, include_ttm: bool = False) -> list[tuple[str, float]]:
    """Ordered [(period, value)] for one statement row (oldest first)."""
    rows = _block(resp).get("data") or {}
    vals = rows.get(row) or {}
    out = [(p, _num(v)) for p, v in vals.items() if (include_ttm or p != "TTM")]
    out = [(p, v) for p, v in out if v is not None]
    return sorted(out, key=lambda x: _period_key(x[0]))


def latest(resp: Any, row: str, include_ttm: bool = True) -> Optional[float]:
    s = series(resp, row, include_ttm)
    return s[-1][1] if s else None


def cagr(first: Optional[float], last: Optional[float], years: float) -> Optional[float]:
    if not first or not last or first <= 0 or last <= 0 or years <= 0:
        return None
    return (last / first) ** (1 / years) * 100 - 100


def _pct_str(s: Any) -> Optional[float]:
    return _num(s)


def _check(label: str, status: str, detail: str = "", key: str = "") -> dict:
    return {"label": label, "status": status, "detail": detail, "key": key}


def _pillar_score(checks: list[dict]) -> Optional[int]:
    scored = [c for c in checks if c["status"] in ("pass", "fail", "neutral")]
    if not scored:
        return None
    pts = sum({"pass": 1.0, "neutral": 0.5, "fail": 0.0}[c["status"]] for c in scored)
    return round(pts / len(scored) * 100)


def _fmt(v: Optional[float], suffix: str = "", nd: int = 1) -> str:
    return "n/a" if v is None else f"{v:,.{nd}f}{suffix}"


# ───────────────────────── main ─────────────────────────

def analyze_fundamentals(raw: dict[str, Any], *, valuation_helper=None, gsec_yield: float = 6.5,
                         prices=None) -> dict:
    """
    raw keys (any may be None): profile, quarterly, profit_loss, balance_sheet, cash_flow, ratios,
    shareholding, forecasts, pledge, score, deals, concall, news, corporate_actions, credit, options.
    valuation_helper: object with _compute_fair_value / _compute_mini_dcf (ValueInvestingService).
    prices: optional daily candles (timestamp, close); used for a P/E history from quarterly EPS when
            analyst actuals (Tapetide forecasts) are unavailable.
    """
    prof = (raw.get("profile") or {}).get("data") or {}
    company = prof.get("company") or {}
    fnd = prof.get("fundamentals") or {}
    pm = prof.get("price_metrics") or {}
    gm = prof.get("growth_metrics") or {}
    qg = prof.get("quarterly_growth") or {}
    quote = prof.get("quote") or {}

    if not prof and not raw.get("profit_loss"):
        return {"available": False, "reason": "No fundamental data returned for this symbol."}

    sector_text = " ".join(str(x or "") for x in (company.get("sector"), company.get("industry"),
                                                  company.get("basic_industry"), fnd.get("industry"))).lower()
    is_financial = any(h in sector_text for h in FINANCIAL_SECTOR_HINTS)

    price = _num(pm.get("price")) or _num(quote.get("price"))
    pe = _num(pm.get("pe_ttm")) or _num(fnd.get("stock_pe"))
    pb = _num(pm.get("pb")) or _num(fnd.get("price_to_book"))
    eps = _num(pm.get("eps_ttm")) or _num(fnd.get("eps"))
    bvps = _num(pm.get("book_value")) or _num(fnd.get("book_value"))
    mcap = _num(fnd.get("market_cap"))
    div_yield = _num(fnd.get("dividend_yield"))

    pl, bs, cf, rt, q = (raw.get(k) for k in ("profit_loss", "balance_sheet", "cash_flow", "ratios", "quarterly"))

    checks: dict[str, list] = {k: [] for k in FUND_WEIGHTS}

    # ───── Growth ─────
    def gm_val(group: str, period: str) -> Optional[float]:
        return _pct_str((gm.get(group) or {}).get(period))

    growth = {
        "sales_cagr": {p: gm_val("Compounded Sales Growth", p) for p in ("3 Years", "5 Years", "10 Years", "TTM")},
        "profit_cagr": {p: gm_val("Compounded Profit Growth", p) for p in ("3 Years", "5 Years", "10 Years", "TTM")},
        "price_cagr": {p: gm_val("Stock Price CAGR", p) for p in ("1 Year", "3 Years", "5 Years", "10 Years")},
        "latest_quarter": qg.get("latest_quarter"),
        "sales_yoy_q": _num(qg.get("sales_yoy")), "profit_yoy_q": _num(qg.get("net_profit_yoy")),
        "sales_qoq": _num(qg.get("sales_qoq")), "profit_qoq": _num(qg.get("net_profit_qoq")),
    }
    eps_s = series(pl, "EPS in Rs")
    if len(eps_s) >= 4:
        growth["eps_cagr_3y"] = _r(cagr(eps_s[-4][1], eps_s[-1][1], 3))
    if len(eps_s) >= 6:
        growth["eps_cagr_5y"] = _r(cagr(eps_s[-6][1], eps_s[-1][1], 5))

    # Quarterly table (last 8 quarters) with YoY growth
    q_sales, q_np, q_opm = series(q, "Sales"), series(q, "Net Profit"), series(q, "OPM %")
    np_map, opm_map = dict(q_np), dict(q_opm)
    q_rows = []
    for i, (per, sales) in enumerate(q_sales):
        prev = q_sales[i - 4][1] if i >= 4 else None
        prev_np = np_map.get(q_sales[i - 4][0]) if i >= 4 else None
        q_rows.append({
            "period": per, "sales": sales, "net_profit": np_map.get(per), "opm": opm_map.get(per),
            "sales_yoy": _r((sales / prev - 1) * 100) if prev else None,
            "profit_yoy": _r((np_map[per] / prev_np - 1) * 100) if prev_np and prev_np > 0 and np_map.get(per) is not None else None,
        })
    growth["quarters"] = q_rows[-8:]
    opm_vals = [v for _, v in q_opm]
    opm_trend = None
    if len(opm_vals) >= 8:
        opm_trend = _r(statistics.mean(opm_vals[-4:]) - statistics.mean(opm_vals[-8:-4]))
    growth["opm_change_4q_vs_prior_4q"] = opm_trend
    # Annual table (last 6 years)
    a_sales, a_np = series(pl, "Sales"), dict(series(pl, "Net Profit"))
    a_opm, a_eps = dict(series(pl, "OPM %")), dict(eps_s)
    growth["annual"] = [{"period": p, "sales": s, "net_profit": a_np.get(p), "opm": a_opm.get(p), "eps": a_eps.get(p)}
                        for p, s in a_sales[-6:]]

    g = checks["growth"]
    s3, p3 = growth["sales_cagr"]["3 Years"], growth["profit_cagr"]["3 Years"]
    if s3 is not None:
        g.append(_check("Sales 3Y CAGR ≥ 10%", "pass" if s3 >= 10 else "neutral" if s3 >= 6 else "fail", f"{s3}%"))
    if p3 is not None:
        g.append(_check("Profit 3Y CAGR ≥ 12%", "pass" if p3 >= 12 else "neutral" if p3 >= 7 else "fail", f"{p3}%"))
    if growth["sales_yoy_q"] is not None:
        g.append(_check("Latest quarter sales up YoY", "pass" if growth["sales_yoy_q"] > 0 else "fail",
                        f"{growth['sales_yoy_q']:+.1f}% ({growth['latest_quarter']})"))
    if growth["profit_yoy_q"] is not None:
        g.append(_check("Latest quarter profit up YoY", "pass" if growth["profit_yoy_q"] > 0 else "fail",
                        f"{growth['profit_yoy_q']:+.1f}%"))
    if opm_trend is not None:
        g.append(_check("Operating margin stable or expanding (last 4Q vs prior 4Q)",
                        "pass" if opm_trend >= 0 else "neutral" if opm_trend > -2 else "fail", f"{opm_trend:+.1f} pts"))
    if growth.get("eps_cagr_5y") is not None:
        g.append(_check("EPS 5Y CAGR ≥ 10%", "pass" if growth["eps_cagr_5y"] >= 10 else "fail", f"{growth['eps_cagr_5y']}%"))

    # ───── Quality ─────
    roe = _num(fnd.get("roe"))
    roce = _num(fnd.get("roce"))
    roce_s = [v for _, v in series(rt, "ROCE %")]
    roce_5y = _r(statistics.mean(roce_s[-5:])) if len(roce_s) >= 3 else None
    roe_hist = {p: gm_val("Return on Equity", p) for p in ("3 Years", "5 Years", "10 Years", "Last Year")}
    cfo = series(cf, "Cash from Operating Activity")
    fcf = series(cf, "Free Cash Flow")
    np_annual = dict(series(pl, "Net Profit"))
    last5 = cfo[-5:]
    np5 = [np_annual.get(p) for p, _ in last5]
    cash_conv = None
    if last5 and all(x is not None for x in np5) and sum(np5) > 0:
        cash_conv = _r(sum(v for _, v in last5) / sum(np5), 2)
    fcf_pos = sum(1 for _, v in fcf[-5:] if v > 0)
    oi_ttm, pbt_ttm = latest(pl, "Other Income"), latest(pl, "Profit before tax")
    oi_share = _r(oi_ttm / pbt_ttm * 100) if oi_ttm is not None and pbt_ttm and pbt_ttm > 0 else None
    debtor = series(rt, "Debtor Days")
    debtor_change = _r(debtor[-1][1] - debtor[-4][1]) if len(debtor) >= 4 else None
    payout = latest(pl, "Dividend Payout %", include_ttm=False)
    tax = latest(pl, "Tax %", include_ttm=False)

    qc = checks["quality"]
    np_ttm = latest(pl, "Net Profit")
    if np_ttm is not None:
        qc.append(_check("Profitable on a TTM basis", "pass" if np_ttm > 0 else "fail", f"net profit ₹{np_ttm:,.0f} Cr"))
    if roe is not None:
        qc.append(_check("ROE ≥ 15%", "pass" if roe >= 15 else "neutral" if roe >= 10 else "fail", f"{roe}%"))
    if roce is not None and not is_financial:
        qc.append(_check("ROCE ≥ 15%", "pass" if roce >= 15 else "neutral" if roce >= 10 else "fail",
                         f"{roce}% (5Y avg {_fmt(roce_5y, '%')})"))
    if cash_conv is not None and not is_financial:
        if cash_conv > 3:  # tiny 5-year profit makes the ratio meaningless
            qc.append(_check("Profits convert to cash (5Y CFO / PAT ≥ 0.8)", "neutral",
                             f"{cash_conv}x — profits too small over 5 years for a meaningful ratio"))
        else:
            qc.append(_check("Profits convert to cash (5Y CFO / PAT ≥ 0.8)", "pass" if cash_conv >= 0.8 else "neutral" if cash_conv >= 0.5 else "fail",
                             f"{cash_conv}x"))
    if fcf and not is_financial:
        n = min(5, len(fcf))
        qc.append(_check(f"Free cash flow positive in most years", "pass" if fcf_pos >= max(1, n - 1) else "neutral" if fcf_pos >= n / 2 else "fail",
                         f"{fcf_pos} of last {n} years"))
    if oi_share is not None and not is_financial:  # fee income is core business for lenders
        qc.append(_check("Core earnings: other income < 25% of PBT", "pass" if oi_share < 25 else "fail", f"{oi_share}% of PBT"))
    if debtor_change is not None and not is_financial:
        qc.append(_check("Debtor days not rising sharply (3Y)", "pass" if debtor_change <= 10 else "neutral" if debtor_change <= 25 else "fail",
                         f"{debtor_change:+.0f} days"))

    # Piotroski F-score (adapted: Tapetide has no current-asset split, so 8 tests)
    pio = _piotroski(pl, bs, cf) if not is_financial else {"available": False, "reason": "Not meaningful for lenders"}
    if pio["available"]:
        qc.append(_check("Piotroski F-score ≥ 6", "pass" if pio["score"] >= 6 else "neutral" if pio["score"] >= 4 else "fail",
                         f"{pio['score']} / {pio['max']}"))

    quality = {"roe": roe, "roe_history": roe_hist, "roce": roce, "roce_5y_avg": roce_5y,
               "roce_series": [{"period": p, "value": v} for p, v in series(rt, "ROCE %")[-6:]],
               "cash_conversion_5y": cash_conv, "fcf_positive_years": fcf_pos, "fcf_years": min(5, len(fcf)),
               "free_cash_flow": [{"period": p, "value": v} for p, v in fcf[-6:]],
               "other_income_pct_pbt": oi_share, "debtor_days": debtor[-1][1] if debtor else None,
               "debtor_days_change_3y": debtor_change, "dividend_payout_pct": payout, "tax_rate_pct": tax,
               "piotroski": pio}

    # ───── Financial health ─────
    eq = latest(bs, "Equity Capital")
    res = latest(bs, "Reserves")
    borrow = latest(bs, "Borrowings")
    net_worth = (eq or 0) + (res or 0)
    de = _r(borrow / net_worth, 2) if borrow is not None and net_worth > 0 else _num(fnd.get("debt_to_equity"))
    interest = latest(pl, "Interest")
    icr = _r((pbt_ttm + interest) / interest, 1) if pbt_ttm is not None and interest and interest > 0 else None
    bor_s = series(bs, "Borrowings")
    sales_s = series(pl, "Sales")
    bor_growth = _r(cagr(bor_s[-4][1], bor_s[-1][1], 3)) if len(bor_s) >= 4 and bor_s[-4][1] > 0 else None
    sales_growth_3 = s3
    hc = checks["financial_health"]
    if is_financial:
        hc.append(_check("Leverage tests", "na", "Not meaningful for banks / NBFCs / insurers (borrowing is the business)"))
    else:
        if de is not None:
            hc.append(_check("Debt / Equity < 0.5", "pass" if de < 0.5 else "neutral" if de < 1 else "fail", f"{de}"))
        if icr is not None:
            hc.append(_check("Interest coverage > 5x", "pass" if icr > 5 else "neutral" if icr > 2.5 else "fail", f"{icr}x"))
        elif interest == 0 or (borrow is not None and borrow == 0):
            hc.append(_check("Interest coverage > 5x", "pass", "Debt-free / negligible interest"))
        if bor_growth is not None and sales_growth_3 is not None:
            hc.append(_check("Borrowings not outgrowing sales (3Y)", "pass" if bor_growth <= sales_growth_3 + 5 else "fail",
                             f"debt CAGR {bor_growth}% vs sales {sales_growth_3}%"))
    eq_s = series(bs, "Equity Capital")
    dilution = None
    if len(eq_s) >= 4 and eq_s[-4][1]:
        dilution = _r((eq_s[-1][1] / eq_s[-4][1] - 1) * 100)
    if net_worth <= 0 and (eq is not None or res is not None):
        hc.append(_check("Positive net worth", "fail", f"₹{net_worth:,.0f} Cr — accumulated losses exceed capital"))
    elif net_worth > 0:
        hc.append(_check("Positive net worth", "pass", f"₹{net_worth:,.0f} Cr"))
    if len(eq_s) >= 4 and eq_s[-4][1]:
        hc.append(_check("No significant equity dilution (3Y)", "pass" if dilution <= 5 else "neutral" if dilution <= 25 else "fail",
                         f"share capital {dilution:+.1f}% (bonus issues, splits and mergers also show up here)"))
    if is_financial:
        # Lenders: judge balance-sheet health by profitability on equity and steady book growth instead.
        nw_s = [(p, (dict(eq_s).get(p) or 0) + v) for p, v in series(bs, "Reserves")]
        if len(nw_s) >= 4 and nw_s[-4][1] > 0:
            bv_cagr = _r(cagr(nw_s[-4][1], nw_s[-1][1], 3))
            hc.append(_check("Net worth compounding ≥ 12% (3Y)", "pass" if (bv_cagr or 0) >= 12 else "neutral" if (bv_cagr or 0) >= 8 else "fail",
                             f"{bv_cagr}% CAGR"))
        if roe is not None:
            hc.append(_check("ROE ≥ 12% (capital adequacy proxy)", "pass" if roe >= 12 else "fail", f"{roe}%"))
    health = {"debt_to_equity": de, "borrowings": borrow, "net_worth": _r(net_worth, 0) if net_worth else None,
              "interest_coverage": icr, "borrowings_cagr_3y": bor_growth, "equity_change_3y_pct": dilution,
              "is_financial": is_financial,
              "balance_sheet": [{"period": p, "borrowings": v, "net_worth": (dict(eq_s).get(p) or 0) + (dict(series(bs, 'Reserves')).get(p) or 0)}
                                for p, v in bor_s[-6:]]}

    # ───── Valuation ─────
    fc = _block(raw.get("forecasts"))
    fc_latest = fc.get("latest") or {}
    actual = fc.get("actuals") or {}
    hist_pe = []
    for k, px in (actual.get("price") or {}).items():
        e = (actual.get("eps") or {}).get(k)
        if _num(px) and _num(e) and _num(e) > 0:
            hist_pe.append(_num(px) / _num(e))
    median_pe = _r(statistics.median(hist_pe), 1) if len(hist_pe) >= 3 else None
    median_pe_basis = "fiscal-year-end price ÷ EPS (5-6Y)" if median_pe else None
    if prices is not None:
        q_pe, n_pts = _pe_from_quarters(q, prices)
        # Analyst "actuals" can be distorted by demergers/restatements; trust the series built from the
        # same statements we score when the two disagree by more than ~1.8x.
        if q_pe and (median_pe is None or not (1 / 1.8 <= median_pe / q_pe <= 1.8)):
            median_pe, median_pe_basis = q_pe, f"quarter-end price ÷ trailing 4Q EPS ({n_pts} quarters)"
    fwd_eps = _num(fc_latest.get("eps_estimate"))
    fwd_pe = _r(price / fwd_eps, 1) if price and fwd_eps and fwd_eps > 0 else None
    target = _num(fc_latest.get("price_estimate"))
    target_hi, target_lo = _num(fc_latest.get("price_estimate_high")), _num(fc_latest.get("price_estimate_low"))
    target_upside = _r((target / price - 1) * 100, 1) if target and price else None
    growth_for_peg = growth.get("eps_cagr_3y") if growth.get("eps_cagr_3y") is not None else p3
    peg = _r(pe / growth_for_peg, 2) if pe and growth_for_peg and growth_for_peg > 0 else None
    ey = _r(100 / pe, 2) if pe and pe > 0 else None
    graham = _r(math.sqrt(22.5 * eps * bvps), 1) if eps and bvps and eps > 0 and bvps > 0 else None
    hist_fair = _r((fwd_eps or eps) * median_pe, 1) if median_pe and (fwd_eps or eps) else None

    fair, dcf = {}, {}
    if valuation_helper is not None and eps and eps > 0:
        try:
            fair = valuation_helper._compute_fair_value(eps=eps, ltp=price or 0, industry_pe=0)
            dcf = valuation_helper._compute_mini_dcf(eps=eps, ltp=price or 0, growth_pct=growth_for_peg or 0)
        except Exception:  # pragma: no cover - defensive
            fair, dcf = {}, {}

    vc = checks["valuation"]
    if pe is not None and median_pe:
        prem = _r((pe / median_pe - 1) * 100, 1)
        vc.append(_check("P/E at or below its own historical median", "pass" if pe <= median_pe else "neutral" if pe <= median_pe * 1.2 else "fail",
                         f"P/E {pe} vs median {median_pe} ({prem:+}%)"))
    if peg is not None:
        vc.append(_check("PEG < 1.5", "pass" if peg < 1 else "neutral" if peg < 1.5 else "fail", f"{peg}"))
    if ey is not None:
        vc.append(_check(f"Earnings yield above 10Y G-sec (~{gsec_yield}%)", "pass" if ey > gsec_yield else "neutral" if ey > gsec_yield * 0.6 else "fail",
                         f"{ey}%"))
    if target_upside is not None:
        vc.append(_check("Analyst mean target above price", "pass" if target_upside > 10 else "neutral" if target_upside > -5 else "fail",
                         f"{target_upside:+}% to ₹{target:,.0f}"))
    if pe is not None and pe <= 0:
        vc.append(_check("Company is profitable (positive PE)", "fail", "Loss-making on a TTM basis"))

    valuation = {"price": price, "pe": pe, "pb": pb, "eps_ttm": eps, "book_value": bvps, "market_cap_cr": mcap,
                 "dividend_yield": div_yield, "median_pe_hist": median_pe, "median_pe_basis": median_pe_basis,
                 "forward_eps": _r(fwd_eps),
                 "forward_pe": fwd_pe, "forward_period": fc_latest.get("eps_estimate_period"),
                 "peg": peg, "earnings_yield": ey, "gsec_yield": gsec_yield, "graham_number": graham,
                 "historical_pe_fair_value": hist_fair,
                 "conservative_fair_range": fair, "mini_dcf": dcf,
                 "analyst_target": {"mean": _r(target, 1), "high": target_hi, "low": target_lo, "upside_pct": target_upside,
                                    "period": fc_latest.get("price_estimate_period")}}

    # ───── Ownership ─────
    sh = _block(raw.get("shareholding"))
    sh_rows = sh.get("data") or {}
    periods = sorted({p for r in sh_rows.values() if isinstance(r, dict) for p in r}, key=_period_key)
    def sh_get(row: str, idx: int) -> Optional[float]:
        if len(periods) < abs(idx):
            return None
        return _num((sh_rows.get(row) or {}).get(periods[idx]))
    own = {"periods": periods[-6:], "table": {}}
    for row in ("Promoters", "FIIs", "DIIs", "Public", "Government"):
        if row in sh_rows:
            own["table"][row] = [_num((sh_rows[row] or {}).get(p)) for p in periods[-6:]]
    prom, prom_q, prom_y = sh_get("Promoters", -1), sh_get("Promoters", -2), sh_get("Promoters", -5)
    inst_now = (sh_get("FIIs", -1) or 0) + (sh_get("DIIs", -1) or 0)
    inst_y = (sh_get("FIIs", -5) or 0) + (sh_get("DIIs", -5) or 0)
    holders_now, holders_y = sh_get("No. of Shareholders", -1), sh_get("No. of Shareholders", -5)
    own.update({
        "promoter": prom, "promoter_change_qoq": _r(prom - prom_q) if prom is not None and prom_q is not None else None,
        "promoter_change_1y": _r(prom - prom_y) if prom is not None and prom_y is not None else None,
        "institutional": _r(inst_now), "institutional_change_1y": _r(inst_now - inst_y) if inst_y else None,
        "shareholders": holders_now,
        "shareholders_change_1y_pct": _r((holders_now / holders_y - 1) * 100) if holders_now and holders_y else None,
    })
    pledge = (raw.get("pledge") or {}).get("data") or {}
    pledge_pct = _num(pledge.get("latest_pledged_pct_of_promoter_holding"))
    own["pledge_pct"] = pledge_pct
    own["pledge_trend"] = [{"quarter": r.get("quarter"), "pct": _num(r.get("pct_promoter_holding_pledged"))}
                           for r in (pledge.get("quarterly_trend") or [])[:4]]
    deals = ((raw.get("deals") or {}).get("data") or {}).get("deals") or []
    own["recent_deals"] = [{"date": d.get("trade_date"), "kind": d.get("deal_kind"), "side": d.get("side"),
                            "entity": d.get("entity_name"), "qty": _num(d.get("quantity")), "price": _num(d.get("price"))}
                           for d in deals[:8]]

    oc = checks["ownership"]
    if prom is not None and prom > 0:
        oc.append(_check("Promoter holding ≥ 40%", "pass" if prom >= 40 else "neutral" if prom >= 25 else "fail", f"{prom}%"))
        if own["promoter_change_1y"] is not None:
            ch = own["promoter_change_1y"]
            oc.append(_check("Promoters not selling (1Y)", "pass" if ch >= -0.5 else "neutral" if ch >= -2 else "fail", f"{ch:+.2f} pts"))
    elif prom == 0:
        oc.append(_check("Promoter holding", "na", "Professionally managed / no promoter group"))
    if pledge_pct is not None:
        oc.append(_check("Promoter pledge < 5%", "pass" if pledge_pct < 5 else "neutral" if pledge_pct < 20 else "fail", f"{pledge_pct}% of promoter stake"))
    if own["institutional_change_1y"] is not None:
        ch = own["institutional_change_1y"]
        oc.append(_check("Institutions (FII + DII) adding (1Y)", "pass" if ch > 0.25 else "neutral" if ch > -0.5 else "fail", f"{ch:+.2f} pts to {inst_now:.1f}%"))

    # ───── Scores ─────
    pillars = {k: _pillar_score(v) for k, v in checks.items()}
    weighted = [(pillars[k], w) for k, w in FUND_WEIGHTS.items() if pillars[k] is not None]
    score = round(sum(s * w for s, w in weighted) / sum(w for _, w in weighted)) if weighted else None
    n_checks = sum(1 for cl in checks.values() for c in cl if c["status"] in ("pass", "fail", "neutral"))
    pillar_cover = sum(w for k, w in FUND_WEIGHTS.items() if pillars[k] is not None) / sum(FUND_WEIGHTS.values())
    confidence = round(min(1.0, n_checks / 14) * pillar_cover, 2)
    if score is not None and confidence < 0.75:
        score = round(50 + (score - 50) * confidence / 0.75)

    # ───── Flags ─────
    red, green = [], []
    for pillar, cl in checks.items():
        for c in cl:
            if c["status"] == "fail":
                red.append(f"{c['label']} — {c['detail']}" if c["detail"] else c["label"])
            elif c["status"] == "pass" and pillar in ("quality", "growth", "financial_health"):
                green.append(f"{c['label']} — {c['detail']}" if c["detail"] else c["label"])
    scorecard = raw.get("scorecard") or []
    for item in scorecard:
        if item.get("type") == "redFlag" and str(item.get("tag")).lower() == "high":
            red.insert(0, f"Tickertape: {item.get('description') or 'high number of red flags'}")
    tscore = (raw.get("score") or {}).get("data") or {}
    gov = (tscore.get("governance") or {}).get("red_flags") or []
    for f in gov:
        red.insert(0, f"Governance flag: {f}")
    credit = ((raw.get("credit") or {}).get("data") or {}).get("ratings") or []
    if credit:
        last_c = credit[0]
        action = str(last_c.get("action") or "").lower()
        if "downgrade" in action:
            red.insert(0, f"Credit rating downgrade by {last_c.get('agency')}: {last_c.get('rating')}")
        elif "upgrade" in action:
            green.insert(0, f"Credit rating upgrade by {last_c.get('agency')}: {last_c.get('rating')}")

    # ───── Governance caps ─────
    # A heavily pledged promoter stake can force selling in a fall, whatever the P&L says; an analyst
    # would not rate such a business "strong", so cap the score instead of letting it average away.
    governance_cap = None
    if pledge_pct is not None and score is not None:
        if pledge_pct >= 50:
            governance_cap = 50
        elif pledge_pct >= 20:
            governance_cap = 65
        if governance_cap is not None:
            red.insert(0, f"Governance: {pledge_pct:.0f}% of the promoter stake is pledged — fundamental score capped at {governance_cap}")
            score = min(score, governance_cap)

    # ───── Qualitative ─────
    concall = None
    summaries = ((raw.get("concall") or {}).get("data") or {}).get("summaries") or []
    if summaries:
        s0 = summaries[0]
        concall = {"period": s0.get("period") or s0.get("as_of"), "highlights": (s0.get("highlights") or [])[:6],
                   "risks": (s0.get("risks") or [])[:6], "guidance": (s0.get("guidance") or [])[:6]}
    news_rows = (raw.get("news") or {}).get("data") or []
    news = [{"title": n.get("title"), "date": (n.get("publish_date") or "")[:10], "sentiment": n.get("sentiment"),
             "url": n.get("source_url") or None, "summary": (n.get("body") or "")[:260]}
            for n in news_rows[:6] if isinstance(n, dict)]
    ca_rows = (raw.get("corporate_actions") or {}).get("data") or []
    actions = [{"type": a.get("action_type"), "kind": a.get("event_kind"), "ex_date": a.get("ex_date"),
                "detail": a.get("description")} for a in ca_rows[:6] if isinstance(a, dict)]

    opt = (raw.get("options") or {}).get("data") or {}
    options = None
    if opt.get("available"):
        exps = [e for e in (opt.get("expiries") or []) if not e.get("oi_thin")]
        e0 = exps[0] if exps else {}
        options = {"iv_rank": _r((_num(opt.get("iv_rank")) or 0) * 100, 1) if opt.get("iv_rank") is not None else None,
                   "iv_percentile": _r((_num(opt.get("iv_percentile")) or 0) * 100, 1) if opt.get("iv_percentile") is not None else None,
                   "expiry": e0.get("expiry"), "atm_iv": _r((_num(e0.get("atm_iv")) or 0) * 100, 1) if e0.get("atm_iv") is not None else None,
                   "pcr_oi": _r(_num(e0.get("put_call_ratio_oi"))), "max_pain": _num(e0.get("max_pain_strike"))}

    return {
        "available": True,
        "score": score,
        "pillars": pillars,
        "weights": FUND_WEIGHTS,
        "checks": checks,
        "company": {
            "name": company.get("name"), "symbol": company.get("nse_symbol") or company.get("symbol"),
            "isin": company.get("isin"), "sector": company.get("sector"), "industry": company.get("industry"),
            "basic_industry": company.get("basic_industry"), "about": company.get("about"),
            "website": company.get("website"), "ceo": company.get("ceo"), "employees": company.get("employees"),
            "classification": fnd.get("company_classification"), "is_fno": company.get("is_fno"),
            "listing_date": company.get("listing_date"), "pros": company.get("pros") or [], "cons": company.get("cons") or [],
        },
        "valuation": valuation,
        "growth": growth,
        "quality": quality,
        "financial_health": health,
        "ownership": own,
        "red_flags": red[:10],
        "green_flags": green[:10],
        "tickertape_scorecard": scorecard or None,
        "governance_cap": governance_cap,
        "data_confidence": confidence,
        "checks_run": n_checks,
        "statement_basis": prof.get("statement_basis"),
        "tapetide_score": ({"score": tscore.get("score"), "percentile": tscore.get("percentile"),
                            "pillars": tscore.get("pillars"), "confidence": tscore.get("confidence")} if tscore else None),
        "concall": concall,
        "news": news,
        "corporate_actions": actions,
        "credit_ratings": [{"agency": c.get("agency"), "rating": c.get("rating"), "action": c.get("action"),
                            "outlook": c.get("outlook"), "date": c.get("date") or c.get("rating_date")} for c in credit[:4]],
        "options": options,
    }


def _piotroski(pl: Any, bs: Any, cf: Any) -> dict:
    """Piotroski F-score on the last two fiscal years (8 of 9 tests; no current-ratio split available)."""
    np_s = dict(series(pl, "Net Profit"))
    sales_s = dict(series(pl, "Sales"))
    opm_s = dict(series(pl, "OPM %"))
    ta_s = dict(series(bs, "Total Assets"))
    bor_s = dict(series(bs, "Borrowings"))
    eq_s = dict(series(bs, "Equity Capital"))
    cfo_s = dict(series(cf, "Cash from Operating Activity"))
    years = [p for p in sorted(np_s, key=_period_key) if p in ta_s and p in cfo_s and p in sales_s]
    if len(years) < 2:
        return {"available": False}
    y0, y1 = years[-2], years[-1]
    ta0, ta1 = ta_s[y0], ta_s[y1]
    if not ta0 or not ta1:
        return {"available": False}
    roa0, roa1 = np_s[y0] / ta0, np_s[y1] / ta1
    tests = [
        ("Positive net profit", np_s[y1] > 0),
        ("Positive operating cash flow", cfo_s[y1] > 0),
        ("ROA improving", roa1 > roa0),
        ("Cash flow exceeds profit (accrual quality)", cfo_s[y1] > np_s[y1]),
        ("Leverage falling (borrowings / assets)", (bor_s.get(y1, 0) / ta1) <= (bor_s.get(y0, 0) / ta0)),
        ("No new shares issued", eq_s.get(y1, 0) <= eq_s.get(y0, 0) * 1.001),
        ("Operating margin improving", opm_s.get(y1, 0) >= opm_s.get(y0, 0)),
        ("Asset turnover improving", sales_s[y1] / ta1 >= sales_s[y0] / ta0),
    ]
    return {"available": True, "score": sum(1 for _, ok in tests if ok), "max": len(tests), "years": [y0, y1],
            "tests": [{"label": lbl, "passed": bool(ok)} for lbl, ok in tests]}


def _pe_from_quarters(q: Any, prices) -> tuple[Optional[float], int]:
    """Median P/E over the quarters we have: close on/just before each quarter end ÷ trailing-4Q EPS."""
    try:
        import pandas as pd

        eps = series(q, "EPS in Rs")
        if len(eps) < 5 or prices is None or len(prices) < 60:
            return None, 0
        px = prices[["timestamp", "close"]].copy()
        px["timestamp"] = pd.to_datetime(px["timestamp"])
        px = px.sort_values("timestamp").set_index("timestamp")["close"]
        pes = []
        for i in range(3, len(eps)):
            ttm = sum(v for _, v in eps[i - 3 : i + 1])
            if ttm <= 0:
                continue
            qend = (_period_key(eps[i][0]) + pd.offsets.MonthEnd(0)).to_pydatetime()
            window = px[:qend]
            if window.empty or (qend - window.index[-1].to_pydatetime()).days > 10:
                continue
            pes.append(float(window.iloc[-1]) / ttm)
        if len(pes) < 3:
            return None, len(pes)
        return _r(statistics.median(pes), 1), len(pes)
    except Exception:  # pragma: no cover - defensive
        return None, 0
