"""TechnoFunda business profile: key points, revenue mix, Wikipedia guard, peers, digest sections, story."""

import asyncio

from backend.services import techno_funda_sources as src
from backend.services.techno_funda_business import _cr, build_business
from backend.services.techno_funda_fundamental import analyze_fundamentals
from tests.test_techno_funda_sources import _page


def test_revenue_mix_parsing():
    lines = ["Revenue Breakup (Q2 FY27):", "- BFSI: 32.8%", "- Retail: 40%", "- Others: 27.2%", "Clients:", "- 100 clients"]
    mix = src.parse_revenue_mix(lines)
    assert mix["title"] == "Revenue Breakup (Q2 FY27)"
    assert [i["label"] for i in mix["items"]] == ["BFSI", "Retail", "Others"]
    # percentages that don't add up to a whole are not presented as a mix
    assert src.parse_revenue_mix(["- Exports: 50%", "- Margin: 20%"]) is None


def test_key_points_and_ids_from_page():
    html = _page().replace("<h1>", '<div class="company-profile"><div class="about"><p>Makes widgets [1].</p></div>'
                                   '<div class="commentary"><p>Revenue Mix:</p><p>- Widgets: 70%</p><p>- Gadgets: 30%</p></div></div>'
                                   '<button data-url="/wiki/company/4321/commentary/v2/">Read More</button>'
                                   '<div data-warehouse-id="999"></div><h1>', 1)
    prof = src.parse_screener_html(html, "ACME")["profile"]["data"]
    assert prof["company"]["about"] == "Makes widgets."
    assert prof["company"]["key_points"] == ["Revenue Mix:", "- Widgets: 70%", "- Gadgets: 30%"]
    assert prof["screener_ids"] == {"company": "4321", "warehouse": "999"}


def test_wikipedia_guard_rejects_other_companies():
    assert src.wiki_title_matches("Tata Consultancy Services Ltd", "Tata Consultancy Services", "TCS")
    assert src.wiki_title_matches("HDFC Bank Ltd", "HDFC Bank", "HDFCBANK")
    assert not src.wiki_title_matches("TCI Finance Ltd", "Transport Corporation of India", "TCIFINANCE")
    assert not src.wiki_title_matches("Sterlite Technologies Ltd", "Sterlite Copper", "STLTECH")


def test_markdown_sections():
    md = "# Title\n\n## Executive Overview\nLine one.\n\n## Risks\n- A\n- B\n\n## Empty\n"
    secs = src.split_markdown_sections(md)
    assert [s["heading"] for s in secs] == ["Executive Overview", "Risks"]
    assert secs[1]["body"] == "- A\n- B"


def test_peers_parsing(monkeypatch):
    html = ("<table><tr><th>S.No.</th><th>Company</th><th>CMP Rs.</th><th>P/E</th><th>Mar Cap Rs.Cr.</th><th>ROCE %</th>"
            "<th>Qtr Sales Var %</th></tr>"
            "<tr><td>1.</td><td><a href='/company/ACME/consolidated/'>Acme</a></td><td>500</td><td>18</td><td>9,000</td><td>27</td><td>13</td></tr>"
            "<tr><td>2.</td><td><a href='/company/RIVAL/'>Rival</a></td><td>200</td><td>30</td><td>4,000</td><td>15</td><td>5</td></tr>"
            "<tr><td></td><td>Median: 2 Co.</td><td>350</td><td>24</td><td>6,500</td><td>21</td><td>9</td></tr></table>")

    class R:
        text = html

        def raise_for_status(self):
            pass

    class C:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            return R()

    monkeypatch.setattr(src.httpx, "AsyncClient", C)
    rows = asyncio.run(src.fetch_screener_peers("1"))
    assert [r["symbol"] for r in rows] == ["ACME", "RIVAL"]
    assert rows[0]["market_cap"] == 9000 and rows[1]["roce"] == 15


def test_build_business_story_and_summary():
    raw = src.parse_screener_html(_page(), "ACME")
    prof = raw["profile"]["data"]
    prof["company"]["key_points"] = ["Segment Mix:", "- Widgets: 70%", "- Gadgets: 30%"]
    raw["peers"] = [{"name": "Acme", "symbol": "ACME", "pe": 18, "market_cap": 9000, "roce": 27, "qtr_sales_var": 13},
                    {"name": "Rival", "symbol": "RIVAL", "pe": 30, "market_cap": 12000, "roce": 15, "qtr_sales_var": 5}]
    raw["wiki"] = {"title": "Acme", "description": "Indian widget maker", "url": "https://en.wikipedia.org/wiki/Acme",
                   "extract": "Acme Limited makes widgets. It was founded in 1990.", "facts": {"founded": ["1990"], "headquarters": ["Pune"]}}
    raw["annual_report"] = {"period": "FY2026", "sections": [{"heading": "Executive Overview", "body": "**Acme** grew 15% on strong widget demand."}]}
    fund = analyze_fundamentals(raw)
    b = build_business(raw, fund)
    assert b["available"]
    assert b["overview"]["about"] == "Makes widgets."
    assert b["overview"]["identity"] == "Indian widget maker"
    assert "grew 15%" in b["overview"]["latest"] and "**" not in b["overview"]["latest"]
    assert b["facts"]["Founded"] == "1990" and b["facts"]["Headquarters"] == "Pune"
    assert b["revenue_mix"]["items"][0] == {"label": "Widgets", "pct": 70.0}
    titles = [s["title"] for s in b["story"]]
    assert "How has it grown?" in titles and "How does it compare with rivals?" in titles
    rivals = next(s for s in b["story"] if s["title"] == "How does it compare with rivals?")["text"]
    assert "number 2 by market value" in rivals and "cheaper than" in rivals
    assert b["peers"]["self"]["symbol"] == "ACME"


def test_indian_crore_formatting():
    assert _cr(123456.0) == "₹1.23 lakh crore"
    assert _cr(45678.0) == "₹45,678 crore"
    assert _cr(-1500.0) == "−₹1,500 crore"
