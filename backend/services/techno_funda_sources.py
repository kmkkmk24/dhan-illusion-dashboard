"""
Free, keyless data sources for the TechnoFunda tab.

  ScreenerSource   screener.in public company page (no login). One request returns 13 quarters,
                   ~12 years of P&L / balance sheet / cash flow / ratios, shareholding, key ratios,
                   compounded-growth tables, pros/cons and sector. robots.txt allows /company/ pages
                   (only search/sort URLs are disallowed, and we never use them).
  TickertapeSource tickertape.in via the installed Bharat-sm-data library: shareholding with
                   promoter pledge, and the Tickertape scorecard.
  YahooPrices      Yahoo Finance chart endpoint: 2 years of daily candles for <SYMBOL>.NS and ^NSEI.

Everything is converted into the same shape the Tapetide MCP returns, so
techno_funda_fundamental.analyze_fundamentals() reads either source unchanged:
    {"data": [{"section": ..., "periods": [...], "data": {row: {period: value}}}]}

These are unofficial website endpoints: callers must treat every method as "may fail" and fall back.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta
from typing import Any, Optional

import httpx
import pandas as pd

logger = logging.getLogger(__name__)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# Screener section id -> our section key
_SECTIONS = {
    "quarters": "quarterly",
    "profit-loss": "profit_loss",
    "balance-sheet": "balance_sheet",
    "cash-flow": "cash_flow",
    "ratios": "ratios",
}
# Lender / NBFC row names -> the industrial names the engine reads.
_ROW_ALIASES = {
    "Revenue": "Sales",
    "Financing Profit": "Operating Profit",
    "Financing Margin %": "OPM %",
    "Borrowing": "Borrowings",
}
_SKIP_ROWS = {"Raw PDF", "YoY Sales growth", "YoY Revenue growth", "Sales growth", "Revenue growth"}


def _num(text: Any) -> Optional[float]:
    if text is None:
        return None
    t = str(text).replace(",", "").replace("%", "").replace("₹", "").replace("Cr.", "").strip()
    if t in ("", "-", "—", "--"):
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _clean_label(label: str) -> str:
    label = re.sub(r"\s*\+\s*$", "", (label or "").replace("\xa0", " ")).strip()
    return _ROW_ALIASES.get(label, label)


# ───────────────────────── Screener ─────────────────────────

class ScreenerSource:
    base = "https://www.screener.in"

    def __init__(self, timeout: float = 20.0):
        self.timeout = timeout

    async def fetch(self, symbol: str) -> dict[str, Any]:
        """Consolidated page first; standalone when the company has no consolidated accounts."""
        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True,
                                     headers={"User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9"}) as client:
            # Consolidated is the analyst default (it includes subsidiaries), but only when it is
            # complete: small companies often file consolidated annuals without quarters.
            html = await self._get(client, f"/company/{symbol}/consolidated/")
            parsed = parse_screener_html(html, symbol) if html else None
            basis = "consolidated"
            if not _complete(parsed):
                await asyncio.sleep(0.6)  # be polite between the two page loads
                html2 = await self._get(client, f"/company/{symbol}/")
                parsed2 = parse_screener_html(html2, symbol) if html2 else None
                if parsed2 and (_complete(parsed2) or _periods_with_data(parsed2.get("profit_loss"))
                                >= _periods_with_data((parsed or {}).get("profit_loss"))):
                    parsed, basis = parsed2, "standalone"
            if not parsed or not parsed.get("profit_loss"):
                raise LookupError(f"Screener has no financials for {symbol}")
            parsed["profile"]["data"]["statement_basis"] = basis
            return parsed

    async def _get(self, client: httpx.AsyncClient, path: str) -> Optional[str]:
        r = await client.get(self.base + path)
        if r.status_code == 404:
            return None
        if r.status_code == 429:
            raise RuntimeError("Screener rate limit (HTTP 429)")
        r.raise_for_status()
        return r.text


def _complete(parsed: Optional[dict]) -> bool:
    return bool(parsed) and _periods_with_data(parsed.get("profit_loss")) >= 3 and _periods_with_data(parsed.get("quarterly")) >= 4


def _periods_with_data(resp: Optional[dict]) -> int:
    if not resp:
        return 0
    rows = (resp.get("data") or [{}])[0].get("data") or {}
    sales = rows.get("Sales") or rows.get("Net Profit") or {}
    return sum(1 for v in sales.values() if v is not None)


def _table_rows(table) -> tuple[list[str], dict[str, dict[str, Optional[float]]], list[str]]:
    trs = table.find_all("tr")
    if not trs:
        return [], {}, []
    head = [th.get_text(" ", strip=True) for th in trs[0].find_all(["th", "td"])]
    periods = [p for p in head[1:] if p]
    rows: dict[str, dict[str, Optional[float]]] = {}
    order: list[str] = []
    for tr in trs[1:]:
        cells = [c.get_text(" ", strip=True) for c in tr.find_all(["th", "td"])]
        if len(cells) < 2:
            continue
        label = _clean_label(cells[0])
        if not label or label in _SKIP_ROWS or label in rows:
            continue
        vals = cells[1 : 1 + len(periods)]
        rows[label] = {p: _num(v) for p, v in zip(periods, vals)}
        order.append(label)
    return periods, rows, order


def parse_screener_html(html: str, symbol: str = "") -> dict[str, Any]:
    """Parse a screener.in company page into Tapetide-shaped sections plus a synthetic profile."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    out: dict[str, Any] = {}

    for sid, key in _SECTIONS.items():
        sec = soup.find("section", id=sid)
        table = sec.find("table") if sec else None
        if not table:
            continue
        periods, rows, order = _table_rows(table)
        if rows:
            out[key] = {"data": [{"section": key, "periods": periods, "row_order": order, "data": rows}]}

    # Shareholding (quarterly tab)
    shp = soup.find(id="quarterly-shp")
    table = shp.find("table") if shp else None
    if table:
        periods, rows, order = _table_rows(table)
        if rows:
            out["shareholding"] = {"data": [{"periods": periods, "row_order": order, "data": rows}]}

    # Key ratios
    top: dict[str, str] = {}
    for li in soup.select("#top-ratios li"):
        n, v = li.select_one(".name"), li.select_one(".value")
        if n and v:
            top[n.get_text(" ", strip=True)] = v.get_text(" ", strip=True)
    hi = lo = None
    if "High / Low" in top:
        parts = top["High / Low"].replace("₹", "").split("/")
        if len(parts) == 2:
            hi, lo = _num(parts[0]), _num(parts[1])
    price = _num(top.get("Current Price"))
    bv = _num(top.get("Book Value"))
    pe = _num(top.get("Stock P/E"))

    # Compounded growth tables -> same keys as Tapetide's growth_metrics
    growth_metrics: dict[str, dict[str, str]] = {}
    for t in soup.select("table.ranges-table"):
        cells = [c.get_text(" ", strip=True) for c in t.find_all(["th", "td"])]
        if not cells:
            continue
        title, rest = cells[0], cells[1:]
        growth_metrics[title] = {rest[i].rstrip(":"): rest[i + 1] for i in range(0, len(rest) - 1, 2)}

    # Company identity
    name = None
    h1 = soup.find("h1")
    if h1:
        name = h1.get_text(" ", strip=True)
    about_el = soup.select_one(".company-profile .about") or soup.select_one(".about p")
    key_points = _key_points(soup.select_one(".company-profile .commentary"))
    wh = soup.select_one("[data-warehouse-id]")
    cid = re.search(r"/wiki/company/(\d+)/", html)
    sector_links = [a.get_text(strip=True) for a in (soup.find("section", id="peers") or soup).select("a[href^='/market/']")]
    website = bse_code = None
    for a in soup.select("a[href^='http']"):
        href = a.get("href") or ""
        txt = a.get_text(" ", strip=True)
        if "bseindia.com" in href and bse_code is None:
            m = re.search(r"/(\d{6})/?$", href)
            bse_code = m.group(1) if m else None
        elif website is None and not any(k in href for k in ("screener.in", "bseindia", "nseindia", ".pdf")) and "." in txt and " " not in txt:
            website = txt
    is_fno = bool(soup.select_one("a[href*='nseindia.com/get-quotes/derivatives']"))

    # TTM EPS from the P&L, latest-quarter growth from the quarterly table
    pl_rows = (out.get("profit_loss") or {}).get("data", [{}])[0].get("data", {})
    eps_row = pl_rows.get("EPS in Rs") or {}
    eps_ttm = eps_row.get("TTM") if eps_row.get("TTM") is not None else (list(eps_row.values())[-1] if eps_row else None)
    qg = _quarterly_growth(out.get("quarterly"))
    roe, roce = _num(top.get("ROE")), _num(top.get("ROCE"))
    mcap = _num(top.get("Market Cap"))

    bs_rows = (out.get("balance_sheet") or {}).get("data", [{}])[0].get("data", {})
    de = None
    try:
        eq = list((bs_rows.get("Equity Capital") or {}).values())[-1] or 0
        res = list((bs_rows.get("Reserves") or {}).values())[-1] or 0
        bor = list((bs_rows.get("Borrowings") or {}).values())[-1]
        de = round(bor / (eq + res), 2) if bor is not None and (eq + res) > 0 else None
    except IndexError:
        pass

    out["profile"] = {"data": {
        "company": {
            "name": name, "nse_symbol": symbol or None, "symbol": symbol or None, "bse_code": bse_code,
            "sector": sector_links[0] if sector_links else None,
            "industry": sector_links[2] if len(sector_links) > 2 else (sector_links[-1] if sector_links else None),
            "basic_industry": sector_links[3] if len(sector_links) > 3 else None,
            "about": _strip_refs(about_el.get_text(" ", strip=True)) if about_el else None,
            "key_points": key_points,
            "pros": [li.get_text(" ", strip=True) for li in soup.select(".pros li")],
            "cons": [li.get_text(" ", strip=True) for li in soup.select(".cons li")],
            "website": website, "is_fno": is_fno,
        },
        "fundamentals": {
            "market_cap": mcap, "stock_pe": pe, "price_to_book": round(price / bv, 2) if price and bv else None,
            "book_value": bv, "dividend_yield": _num(top.get("Dividend Yield")), "roe": roe, "roce": roce,
            "eps": eps_ttm, "high_52w": hi, "low_52w": lo, "debt_to_equity": de,
            "face_value": _num(top.get("Face Value")),
        },
        "price_metrics": {"price": price, "pe_ttm": pe, "pb": round(price / bv, 2) if price and bv else None,
                          "eps_ttm": eps_ttm, "book_value": bv, "high_52w": hi, "low_52w": lo},
        "growth_metrics": growth_metrics,
        "quarterly_growth": qg,
        "quote": {"price": price},
        "source": "screener",
        "screener_ids": {"company": cid.group(1) if cid else None, "warehouse": wh.get("data-warehouse-id") if wh else None},
    }}
    return out


def _quarterly_growth(q: Optional[dict]) -> dict:
    if not q:
        return {}
    rows = q["data"][0]["data"]
    periods = q["data"][0]["periods"]
    if len(periods) < 2:
        return {}

    def g(row: str, back: int) -> Optional[float]:
        s = rows.get(row) or {}
        if len(periods) <= back:
            return None
        now, then = s.get(periods[-1]), s.get(periods[-1 - back])
        if now is None or not then or then <= 0:
            return None
        return round((now / then - 1) * 100, 2)

    return {"latest_quarter": periods[-1], "sales_yoy": g("Sales", 4), "net_profit_yoy": g("Net Profit", 4),
            "sales_qoq": g("Sales", 1), "net_profit_qoq": g("Net Profit", 1)}


def _strip_refs(text: str) -> str:
    """Drop Screener's [1] citation markers and tidy spacing."""
    text = re.sub(r"\s*\[\d+\]", "", text or "")
    return re.sub(r"[ \t]+", " ", text).strip()


def _key_points(el) -> list[str]:
    """Screener 'Key Points' (the public part shown on the page) as clean lines."""
    if el is None:
        return []
    lines, buf = [], ""
    for raw in el.get_text("\n", strip=True).split("\n"):
        t = _strip_refs(raw)
        if not t or t in (":", "-"):
            continue
        # The HTML splits sentences around bold spans; glue fragments back together.
        if buf and (t[0].islower() or t[0] in ",.%)" or buf.endswith(("a", "the", "of", "in", "and", "with")) and not t.startswith("-")):
            buf += " " + t
        elif t == ":" or t.startswith(":"):
            buf += t
        else:
            if buf:
                lines.append(buf)
            buf = t
    if buf:
        lines.append(buf)
    out = [re.sub(r"\s+([,.:%)])", r"\1", ln) for ln in lines if ln.lower() not in ("read more", "key points")]
    return out[:40]


def parse_revenue_mix(lines: list[str]) -> Optional[dict]:
    """'Revenue Breakup (Q2 FY27):' + '- BFSI: 32.8%' lines → {title, items:[{label, pct}]} if they sum sensibly."""
    title, items = None, []
    for ln in lines:
        m = re.match(r"^[-•]?\s*([A-Za-z][^:]{1,60}?):\s*~?(\d+(?:\.\d+)?)\s*%$", ln)
        if m:
            items.append({"label": m.group(1).strip(), "pct": float(m.group(2))})
        elif ln.endswith(":") and not items:
            title = ln.rstrip(":")
        elif items:
            break
    if len(items) >= 2 and 80 <= sum(i["pct"] for i in items) <= 102:
        return {"title": title, "items": items}
    return None


async def fetch_screener_peers(warehouse_id: str) -> list[dict]:
    """Peer comparison table (public endpoint used by the company page)."""
    from bs4 import BeautifulSoup

    async with httpx.AsyncClient(timeout=20, headers={"User-Agent": UA, "X-Requested-With": "XMLHttpRequest"}) as client:
        r = await client.get(f"{ScreenerSource.base}/api/company/{warehouse_id}/peers/")
        r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    trs = soup.find_all("tr")
    if not trs:
        return []
    head = [c.get_text(" ", strip=True) for c in trs[0].find_all(["th", "td"])]
    keymap = {"Company": "name", "CMP": "price", "P/E": "pe", "Mar Cap": "market_cap", "Div Yld": "div_yield",
              "NP Qtr": "np_qtr", "Qtr Profit Var": "qtr_profit_var", "Sales Qtr": "sales_qtr",
              "Qtr Sales Var": "qtr_sales_var", "ROCE": "roce"}
    cols = []
    for h in head:
        cols.append(next((v for k, v in keymap.items() if h.startswith(k)), None))
    rows = []
    for tr in trs[1:]:
        cells = tr.find_all(["th", "td"])
        texts = [c.get_text(" ", strip=True) for c in cells]
        if not texts or "median" in " ".join(texts).lower():
            continue
        row: dict[str, Any] = {}
        for col, cell, txt in zip(cols, cells, texts):
            if col == "name":
                a = cell.find("a")
                row["name"] = txt
                m = re.search(r"/company/([^/]+)/", (a.get("href") if a else "") or "")
                row["symbol"] = m.group(1) if m else None
            elif col:
                row[col] = _num(txt)
        if row.get("name"):
            rows.append(row)
    return rows[:12]


_WIKI_API = "https://en.wikipedia.org/w/api.php"
_WIKIDATA_API = "https://www.wikidata.org/w/api.php"
_WIKI_UA = {"User-Agent": "IllusionDashboard/1.0 (personal stock-research tool; python-httpx)"}
_NAME_STOP = {"ltd", "limited", "the", "india", "indian", "and", "&", "co", "company", "corporation", "corp", "inc", "of", "pvt", "private"}


def _name_tokens(name: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9]+", (name or "").lower()) if t not in _NAME_STOP and len(t) > 1}


def wiki_title_matches(company: str, title: str, symbol: str = "") -> bool:
    """Guard against Wikipedia returning a different company: most name tokens must be in the title."""
    want, have = _name_tokens(company), _name_tokens(title)
    if not want:
        return False
    if symbol and symbol.lower() in have:
        return True
    overlap = len(want & have) / len(want)
    return overlap >= 0.67 and len(want & have) >= min(2, len(want))


class WikipediaSource:
    """Company background (intro text) and a few stable facts from Wikidata. Free, no key."""

    # Wikidata properties we trust enough to show (CEO/products are often stale or too generic).
    FACTS = {"P571": "founded", "P159": "headquarters", "P112": "founders", "P452": "industry",
             "P1128": "employees", "P749": "parent"}

    async def profile(self, company: str, symbol: str = "") -> Optional[dict]:
        if not company:
            return None
        q = re.sub(r"\b(ltd|limited)\.?$", "", company, flags=re.I).strip()
        async with httpx.AsyncClient(timeout=15, headers=_WIKI_UA) as client:
            r = await client.get(_WIKI_API, params={"action": "query", "list": "search", "srsearch": f"{q} company India",
                                                    "srlimit": 3, "format": "json"})
            r.raise_for_status()
            hits = [h["title"] for h in (r.json().get("query") or {}).get("search", [])]
            ok = [h for h in hits if wiki_title_matches(company, h, symbol)]
            # Prefer the page whose name adds the fewest extra words ("Vedanta Limited" over "Vedanta Resources").
            title = min(ok, key=lambda h: len(_name_tokens(h) - _name_tokens(company))) if ok else None
            if not title:
                return None
            r = await client.get(_WIKI_API, params={"action": "query", "prop": "extracts|description|pageprops|info",
                                                    "inprop": "url", "exintro": 1, "explaintext": 1, "redirects": 1,
                                                    "titles": title, "format": "json"})
            r.raise_for_status()
            page = next(iter(((r.json().get("query") or {}).get("pages") or {}).values()), {})
            desc = page.get("description") or ""
            if not page.get("extract") or "disambiguation" in desc.lower():
                return None
            out = {"title": page.get("title"), "description": desc, "url": page.get("fullurl"),
                   "extract": page.get("extract", "").strip(), "facts": {}}
            qid = (page.get("pageprops") or {}).get("wikibase_item")
            if qid:
                try:
                    out["facts"] = await self._facts(client, qid)
                except Exception as e:  # facts are a bonus
                    logger.info("Wikidata facts failed for %s: %s", qid, e)
            return out

    async def _facts(self, client: httpx.AsyncClient, qid: str) -> dict:
        r = await client.get(_WIKIDATA_API, params={"action": "wbgetentities", "ids": qid, "props": "claims", "format": "json"})
        r.raise_for_status()
        claims = ((r.json().get("entities") or {}).get(qid) or {}).get("claims") or {}
        raw: dict[str, list] = {}
        ids: set[str] = set()
        for prop, label in self.FACTS.items():
            vals = []
            for cl in claims.get(prop, [])[:6]:
                v = ((cl.get("mainsnak") or {}).get("datavalue") or {}).get("value")
                if isinstance(v, dict) and "id" in v:
                    vals.append(v["id"]); ids.add(v["id"])
                elif isinstance(v, dict) and "time" in v:
                    vals.append(v["time"][1:5])
                elif isinstance(v, dict) and "amount" in v:
                    vals.append(v["amount"].lstrip("+"))
            if vals:
                raw[label] = vals
        labels = {}
        if ids:
            r = await client.get(_WIKIDATA_API, params={"action": "wbgetentities", "ids": "|".join(sorted(ids)[:50]),
                                                        "props": "labels", "languages": "en", "format": "json"})
            r.raise_for_status()
            labels = {k: ((v.get("labels") or {}).get("en") or {}).get("value") for k, v in (r.json().get("entities") or {}).items()}
        facts = {}
        for k, vals in raw.items():
            names = [labels.get(v) or v for v in vals if not (str(v).startswith("Q") and not labels.get(v))]
            if k == "employees":
                names = names[-1:]  # latest figure
            if names:
                facts[k] = names
        return facts


def split_markdown_sections(md: str) -> list[dict]:
    """'## Heading' blocks → [{heading, body}] (the H1 title line is dropped)."""
    sections, cur = [], None
    for line in (md or "").splitlines():
        if line.startswith("## "):
            if cur:
                sections.append(cur)
            cur = {"heading": line[3:].strip(), "body": ""}
        elif line.startswith("# "):
            continue
        elif cur is not None:
            cur["body"] += line + "\n"
    if cur:
        sections.append(cur)
    for sec in sections:
        sec["body"] = sec["body"].strip()
    return [sec for sec in sections if sec["body"]]


async def fetch_markdown(url: str) -> Optional[str]:
    async with httpx.AsyncClient(timeout=20, headers={"User-Agent": UA}, follow_redirects=True) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.text if "markdown" in r.headers.get("content-type", "") or r.text.lstrip().startswith("#") else None


# ───────────────────────── Tickertape ─────────────────────────

class TickertapeSource:
    """Shareholding with pledge + scorecard. The library is synchronous, so calls run in a thread."""

    async def fetch(self, symbol: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._fetch_sync, symbol)

    @staticmethod
    def _fetch_sync(symbol: str) -> dict[str, Any]:
        import warnings

        warnings.filterwarnings("ignore")
        from Fundamentals.TickerTape import Tickertape  # Bharat-sm-data

        tt = Tickertape()
        _t, raw = tt.get_ticker(symbol, search_place="stock")
        hits = raw if isinstance(raw, list) else []
        hit = next((h for h in hits if str(h.get("ticker", "")).upper() == symbol.upper()), None)
        if not hit:
            raise LookupError(f"Tickertape has no stock with ticker {symbol}")
        out: dict[str, Any] = {"tickertape": {"sid": hit.get("sid"), "slug": hit.get("slug"), "sector": hit.get("sector")}}

        try:
            df = tt.get_share_holding_pattern(str(hit.get("slug", "")).strip("/"))
            if df is not None and not df.empty:
                out.update(_tickertape_shareholding(df))
        except Exception as e:  # pragma: no cover - network/parse
            logger.info("Tickertape shareholding failed for %s: %s", symbol, e)
        try:
            sc = tt.get_score_card(hit.get("sid"))
            if sc is not None and not sc.empty:
                out["scorecard"] = [{"name": r.get("name"), "tag": r.get("tag"), "type": r.get("type"),
                                     "description": r.get("description")} for r in sc.to_dict(orient="records")]
        except Exception as e:  # pragma: no cover
            logger.info("Tickertape scorecard failed for %s: %s", symbol, e)
        return out


def _tickertape_shareholding(df: pd.DataFrame) -> dict[str, Any]:
    """pmPctT promoter % of shares, pmPctP % of promoter stake pledged, fiPctT FII, diPctT DII, mfPctT MF."""
    df = df.sort_values("date")
    labels = [datetime.fromisoformat(str(d).replace("Z", "+00:00")).strftime("%b %Y") for d in df["date"]]
    col = lambda c: {p: (round(float(v), 2) if pd.notna(v) else None) for p, v in zip(labels, df.get(c, pd.Series([None] * len(df))))}
    shareholding = {"data": [{"periods": labels, "data": {
        "Promoters": col("data_pmPctT"), "FIIs": col("data_fiPctT"), "DIIs": col("data_diPctT"),
        "Public": col("data_rhPctT"), "Mutual Funds": col("data_mfPctT"),
    }}]}
    trend = []
    for p, d, pp in zip(labels, df["date"], df.get("data_pmPctP", pd.Series([None] * len(df)))):
        trend.append({"quarter": str(d)[:10], "pct_promoter_holding_pledged": None if pd.isna(pp) else round(float(pp), 2)})
    trend.reverse()
    latest = trend[0]["pct_promoter_holding_pledged"] if trend else None
    return {"shareholding": shareholding,
            "pledge": {"data": {"available": latest is not None, "latest_pledged_pct_of_promoter_holding": latest,
                                "quarterly_trend": trend[:4], "source": "tickertape"}}}


# ───────────────────────── Yahoo prices ─────────────────────────

class YahooPrices:
    url = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}"

    async def isin_to_ticker(self, isin: str) -> Optional[str]:
        """ISIN → NSE ticker via Yahoo search ('INE467B01029' → 'TCS'); BSE-only listings return None."""
        async with httpx.AsyncClient(timeout=15, headers={"User-Agent": UA}) as client:
            r = await client.get("https://query2.finance.yahoo.com/v1/finance/search",
                                 params={"q": isin, "quotesCount": 5, "newsCount": 0})
            r.raise_for_status()
            for q in r.json().get("quotes") or []:
                sym = str(q.get("symbol") or "")
                if sym.endswith(".NS"):
                    return sym[:-3].upper()
        return None

    async def daily(self, yahoo_symbol: str, range_: str = "2y") -> Optional[pd.DataFrame]:
        async with httpx.AsyncClient(timeout=20, headers={"User-Agent": UA}) as client:
            r = await client.get(self.url.format(sym=yahoo_symbol), params={"range": range_, "interval": "1d"})
            r.raise_for_status()
            return parse_yahoo_chart(r.json())


def parse_dhan_quote(payload: Optional[dict], segment: str, security_id: str) -> Optional[dict]:
    """Dhan /marketfeed/quote → {ltp, open, high, low, volume, prev_close, ts} (ts = naive IST)."""
    try:
        d = ((payload or {}).get("data") or {}).get(segment, {}).get(str(security_id)) or {}
    except AttributeError:
        return None
    ltp = _num(d.get("last_price"))
    if not ltp:
        return None
    ohlc = d.get("ohlc") or {}
    ts = None
    if d.get("last_trade_time"):
        try:
            ts = datetime.strptime(str(d["last_trade_time"]), "%d/%m/%Y %H:%M:%S")
        except ValueError:
            ts = None
    return {"ltp": ltp, "open": _num(ohlc.get("open")), "high": _num(ohlc.get("high")), "low": _num(ohlc.get("low")),
            "prev_close": _num(ohlc.get("close")), "volume": _num(d.get("volume")), "ts": ts,
            "high_52w": _num(d.get("52_week_high")), "low_52w": _num(d.get("52_week_low"))}


def merge_live_candle(df: Optional[pd.DataFrame], q: Optional[dict]) -> tuple[Optional[pd.DataFrame], bool]:
    """Append today's in-progress candle from a live quote.

    Dhan's daily-candle API only returns a day after the close, so during market hours the last row is
    yesterday. If the quote is for a later date than the last candle, add a provisional candle
    (close = LTP). Once the official daily candle exists, it is kept and the quote is ignored.
    """
    if df is None or df.empty or not q or not q.get("ltp") or not q.get("ts"):
        return df, False
    qd = pd.Timestamp(q["ts"]).normalize()
    last = pd.Timestamp(df["timestamp"].iloc[-1]).normalize()
    if qd <= last:
        return df, False
    ltp = float(q["ltp"])
    o = float(q.get("open") or ltp)
    row = {"timestamp": qd, "open": o, "high": max(float(q.get("high") or ltp), ltp, o),
           "low": min(float(q.get("low") or ltp), ltp, o), "close": ltp, "volume": float(q.get("volume") or 0)}
    out = pd.concat([df, pd.DataFrame([row])], ignore_index=True)
    out.attrs = dict(df.attrs)
    return out, True


def missing_sessions(df: Optional[pd.DataFrame], lookback_days: int = 30) -> list[str]:
    """Trading days (per the NSE calendar) absent from a candle series, e.g. Yahoo gaps."""
    if df is None or df.empty:
        return []
    from backend.services.market_calendar import is_trading_day, today_ist

    have = set(pd.to_datetime(df["timestamp"]).dt.date)
    end = today_ist() - timedelta(days=1)
    start = max(end - timedelta(days=lookback_days), min(have))
    out, d = [], start
    while d <= end:
        if is_trading_day(d) and d not in have:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def parse_yahoo_chart(payload: dict) -> Optional[pd.DataFrame]:
    res = ((payload or {}).get("chart") or {}).get("result") or []
    if not res:
        return None
    r0 = res[0]
    ts = r0.get("timestamp") or []
    q = ((r0.get("indicators") or {}).get("quote") or [{}])[0]
    if not ts:
        return None
    df = pd.DataFrame({
        "timestamp": pd.to_datetime(ts, unit="s", utc=True).tz_convert("Asia/Kolkata").tz_localize(None).normalize(),
        "open": q.get("open"), "high": q.get("high"), "low": q.get("low"), "close": q.get("close"), "volume": q.get("volume"),
    })
    df = df.dropna(subset=["close"]).drop_duplicates("timestamp", keep="last").reset_index(drop=True)
    if df.empty:
        return None
    meta = r0.get("meta") or {}
    if meta.get("regularMarketPrice") and meta.get("regularMarketTime"):
        ts = pd.Timestamp(meta["regularMarketTime"], unit="s", tz="UTC").tz_convert("Asia/Kolkata").tz_localize(None)
        df.attrs["live"] = {"ltp": float(meta["regularMarketPrice"]), "ts": ts.to_pydatetime(),
                            "source": "Yahoo Finance (can lag by up to ~15 minutes)"}
    return df
