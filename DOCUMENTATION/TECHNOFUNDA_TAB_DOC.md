# TechnoFunda Analysis Tab — How It Works

Search one NSE stock and get a combined fundamental + technical report with a single verdict.

## 1) Search
**Frontend**: `tfSearch()` → **GET** `/api/techno-funda/search?q=…`
- Searches the local instrument master (free, instant).
- Rows without an NSE ticker (instrument list refreshed before ticker mapping existed) are analysed
  by ISIN. *Settings → Refresh instruments* fills the tickers in.
- "Search brand / old names via Tapetide" (`deep=true`) costs 1 Tapetide call — e.g. "Zomato" → ETERNAL.

## 2) Analyse
**Frontend**: `tfAnalyze(symbol)` → **GET** `/api/techno-funda/analyze/{symbol}`
(`refresh=true` rebuilds with fresh candles, `refresh_fundamentals=true` re-downloads fundamentals).

**Backend**: `backend/services/techno_funda_service.py`
1. Fundamentals, fetched in parallel and cached on disk in `data/techno_funda_cache/{SYMBOL}.json` for 24 h
   (`backend/services/techno_funda_sources.py`):
   - **Screener.in public company page** (free, no login; robots.txt allows `/company/` pages): 13 quarters,
     ~12 years of P&L / balance sheet / cash flow / ratios, shareholding, key ratios, compounded-growth
     tables, pros/cons, sector. Consolidated accounts are used when complete (annual + quarterly), else standalone.
     Lender rows (Revenue, Financing Margin %, Borrowing) are mapped to the industrial names the engine reads.
   - **Tickertape** (free, via the installed Bharat-sm-data library): promoter pledge history, scorecard,
     shareholding fallback.
   - **Tapetide MCP extras** (`techno_funda.tapetide_extras`, default `forecasts`, `concall`, `news`; also
     `deals`, `score`, `corporate_actions`, `credit`, `options`) — 1 quota call each.
   - **Tapetide core** (profile + all statements in one call, shareholding, pledge) only if Screener fails.
   - Tickers missing from the instrument list are resolved from the ISIN via Yahoo search (free), then
     Tickertape, then Tapetide.
2. Prices: **Dhan** daily candles (2 years) for the stock and NIFTY 50 → **Yahoo Finance** chart endpoint
   (free; `SYMBOL.NS` and `^NSEI`, BSE code as a last try) → Tapetide price history (~6 months, 1 call).
3. `techno_funda_fundamental.py` and `techno_funda_technical.py` score each side 0–100; the service combines them.
   The report footer lists which source supplied each section.

### Business profile (`techno_funda_business.py`)
- **Summary → "What the company does"**: Screener's about text, the Wikipedia one-line identity, the latest
  annual-report overview, key facts (founded, HQ, industry, employees) and the revenue mix when published.
- **Fundamental → "Business deep dive"**: the business (about + Wikipedia background + facts), where the money
  comes from (revenue mix / key points), *the story in numbers* (plain-English paragraphs written
  deterministically from 10+ years of financials, shareholding and peers), the annual-report digest
  (collapsible sections, link to the original PDF) and an industry/peers table.
- Sources: Screener page + `/api/company/{id}/peers/` (free), Wikipedia/Wikidata (free; a name-match guard
  rejects other companies; CEO/products from Wikidata are skipped as often stale), Tapetide
  `list_company_documents` (1 call) + the public digest Markdown file. Cached with the fundamentals; stocks
  saved earlier are backfilled once.

### Tapetide budget
The free plan allows **50 tool calls per day** (resets midnight IST), shared with the Value Investing tab.
A new stock costs ~3 calls (the extras); a saved stock costs 0. The tab tracks its own usage
(`/api/techno-funda/quota`); once the daily limit is hit, reports still work from the free sources and
simply omit (or reuse saved) forecasts, concall digest and news.

### Analyst safeguards
- **Governance cap**: ≥ 50% of the promoter stake pledged caps the fundamental score at 50 (≥ 20% → 65).
- **Data confidence**: when fewer than ~14 checks could run, the score is pulled toward 50.
- **Profitability / solvency**: explicit "profitable on a TTM basis" and "positive net worth" checks.
- **Median P/E**: analyst fiscal-year actuals by default; when they disagree with the P/E series built
  from quarterly EPS and prices by more than 1.8×, the quarterly series is used (demergers/restatements).

## 3) Scoring
**Fundamental (0–100)** — quality 30, growth 25, financial health 20, valuation 15, ownership 10.
Checks include ROE/ROCE, cash conversion (CFO/PAT), FCF consistency, other-income dependence, debtor days,
Piotroski F-score (8 tests), sales/profit CAGR, quarterly YoY, margin trend, D/E, interest cover, debt vs
sales growth, dilution, P/E vs its own median, PEG, earnings yield vs G-sec, analyst target, promoter
holding/selling, pledge, institutional flows. Banks/NBFCs/insurers skip industrial leverage, other-income and
Piotroski tests and use net-worth growth instead.

Valuation models shown: own-median-P/E value, Graham number, the Value Investing tab's 12–20× fair-value
band and mini-DCF (reused from `ValueInvestingService`), analyst consensus.

**Technical (0–100)** — trend 35, momentum 25, relative strength 20, volume 10, risk 10.
SMA 20/50/100/150/200, EMA 9/21, golden/death cross, Minervini trend template, Weinstein stage (30-week MA),
RSI, MACD, ADX/DI, stochastic, returns vs NIFTY 50, Mansfield RS, OBV, accumulation/distribution days,
up/down volume, ATR, Bollinger %B and squeeze, drawdown, swing support/resistance, weekly pivots,
Fibonacci levels, and ATR/structure-based reference levels (entry zone, stop, targets with R-multiples).

**Verdict** — `0.55 × fundamental + 0.45 × technical` (configurable), a quadrant
("Quality in momentum", "Good business, weak chart", "Momentum without fundamental support", …),
key positives/risks and the price levels that would change the view.

## `config.yaml` (optional)
```yaml
techno_funda:
  cache_minutes: 15
  fundamentals_cache_hours: 24
  history_days: 730
  gsec_10y_yield: 6.5
  tapetide_concurrency: 6
  tapetide_extras: ["concall", "news"]   # add "deals", "score", "corporate_actions", "credit", "options"
  verdict_weights: { fundamental: 0.55, technical: 0.45 }
```

The report is decision support generated from public data, not investment advice.
