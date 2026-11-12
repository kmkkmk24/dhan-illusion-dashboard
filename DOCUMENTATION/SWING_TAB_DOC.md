# Swing Trades tab

Three swing setups — **VCP**, **Flag** and **IPO base** — found every trading day, ranked so that only a
handful are suggested, with execution on Dhan, automated trade management and an automated accuracy
scorecard. Code lives in `backend/services/swing/`, the API in `backend/api/swing.py`.

## Daily pipeline (`engine.py`)

| Step | What | Cost |
|---|---|---|
| NSE intel | results / board-meeting calendar, ASM + GSM surveillance lists, bulk & block deals | 4 requests |
| Bhavcopy | `sec_bhavdata_full_DDMMYYYY.csv`: official OHLC, volume, **delivery %** for every stock | 1 download / day |
| Universe | EQ series, price ≥ `min_price`, 20-day avg traded value ≥ `min_turnover_cr`, not under ASM/GSM | none |
| Candles | new stocks back-filled once from Dhan (~3 years), then appended from the bhavcopy | Dhan only for new names |
| Detect | VCP / Flag / IPO detectors per stock, one frame in memory at a time | CPU only |
| Rank | RS rating (percentile across the universe), market regime, sector rank + rotation, score 0–100 | none |
| Persist | `swing_setups` lifecycle; the plan is frozen the first day it is suggested | — |
| Accuracy | every frozen plan is replayed on the candles that followed | — |

The first scan back-fills ~1,000 stocks (≈30 min, once). Afterwards a scan takes seconds.
Splits/bonuses are detected from the bhavcopy's `PREV_CLOSE` and the stored history is rescaled.

Schedule (`scheduler.py`): EOD scan 18:45 IST (retry 20:30 if the bhavcopy was late), then trade advice
and the Telegram digest. During market hours every 2 min: fill detection, protection retries, exit
detection, breakout alerts for top picks.

## Setups (`setups.py`)

All patterns are measured on data up to **yesterday**; today's bar only tests the breakout.

* **VCP** — Stage-2 gate (price > rising 200-DMA, 50 > 200, within 25% of the 52-week high). Base of
  15–130 days, ≤ 40% deep; zig-zag contractions that shrink (e.g. 18% → 9% → 4%), final ≤ 12%, right
  side recovered to ≥ 85% of the base high. Entry = pivot + 0.2%; stop = low of the last contraction.
* **Flag** — pole ≥ 15% in ≤ 20 days that reaches prior highs; flag of 3–15 days giving back ≤ 50% of
  the pole, holding the 21-EMA, 50-DMA rising. Entry = high of the last ≤ 5 flag days; stop = flag low;
  T2 includes the measured move (80% of the pole).
* **IPO base** — listed ≤ 2 years (NSE IPO tracker / equity list), trading above the issue price, base
  below the post-listing high ≤ 40% deep, last 10 days ≤ 18% range. Entry = break to a new all-time high.

Common plan rules: stop ≥ 1 ATR below entry (no noise stop-outs); a stop wider than 8% (9% for IPOs)
marks the setup *wide* and it is never a top pick; T1 = 2R, T2 = max(3R, pattern target).
Status: **triggered** (closed above entry today, ≤ 4% above), **ready** (≤ 3% below; 5% for IPOs),
**forming** (3–10% below), **extended** (> 4% above — do not chase). An intraday poke above the pivot
that closes back below is flagged as an *upthrust*.

## Score (0–100) and selection

| Component | Weight | Source |
|---|---|---|
| Pattern | 35 | detector quality (contractions, tightness, volume dry-up, retrace, …) |
| Trend | 15 | Minervini trend template (7 checks) |
| Relative strength | 15 | RS rating 1–99 (+ RS line at a new high) |
| Sector | 15 | Sector Analysis rank + weekly rotation quadrant |
| Smart money | 12 | up/down volume, delivery % trend, bulk/block deals, SMC (liquidity sweep, BOS, FVG, order block) |
| Risk / room | 8 | stop distance, distance to the next resistance (none at all-time highs) |

Tiers: A+ ≥ 80, A ≥ 70, B ≥ 60. **Top picks** = ready/triggered, not wide, RS ≥ 60, no results within
`earnings_block_days`, max `max_per_sector` per sector, at most `top_picks` names, and gated by the
market regime: uptrend → A+/A, caution → A+ only, downtrend → none.

**Market regime** (`regime.py`): Nifty vs 21-EMA / 50 / 200-DMA and slope (60 pts) + breadth of the
universe (% above 50-DMA, 52-week highs vs lows, 40 pts). Position size ×1 / ×0.5 / blocked.

## Consistency across days (setup lifecycle)

A setup keeps its identity (one `swing_setups` row) from the day it is found until it ends:

* **Frozen plan** — once suggested (ready/breakout, grade B+), entry / stop / targets never move. If the
  pattern's fresh levels differ, they are shown as a note only.
* **After a breakout** the detector no longer sees a base, so the setup is *carried* on its plan:
  `Breakout · day N` within 4% above the entry, `Extended` above that, `Ready` on a retest within 2%
  under the entry. It ends as **failed** (close > 2% under the entry), **invalidated** (stop broken) or
  **expired** (more than 5 sessions after the breakout).
* **Grace** — a ready/forming setup the detector misses (one-candle change) is carried on its last plan
  for up to 2 sessions.
* **Incumbent top picks** — yesterday's picks keep their place while still actionable; only free slots
  go to new names.

## Trades (`trades.py`)

Modes: **paper** (tracked only), **gtt** (Dhan Forever Order BUY, trigger = entry, limit +0.5%: a buy-stop
that never chases a big gap), **limit** (CNC limit now, AMO when closed). After the fill one **OCO GTT**
(target + stop-loss, CNC) protects the position; it is retried every cycle and the trade shows
UNPROTECTED (plus a Telegram alert) until it is live. eDIS authorisation is checked — without it (or
DDPI) Dhan rejects the stop-loss sell.

Guards: stop < entry < target, stop ≤ 15% away, risk ≤ 3% of capital unless overridden, one open trade
per stock, `max_open_trades`, live entries blocked in a downtrend unless overridden, buy-stop refused
when the price is already above the entry, limit refused > 4% above the entry. Stops can only be raised.

End-of-day advice: failed breakout (close < entry −2% within 3 sessions → exit), close < 50-DMA on
1.5× volume → exit, T1 → book half + stop to breakeven, +1.5R → breakeven, > 2R → trail under the
21-EMA (10-EMA for flags) − ½ ATR, 10 sessions < +0.5R → time stop, results within 2 days → tighten.
`auto_trail: true` applies stop moves to the Dhan GTT automatically.

## Accuracy (`evaluator.py`)

Suggested plans (ready/triggered, grade ≥ B, not wide) are replayed honestly: gap-up fills at the open,
gap-down through the stop fills at the open, stop first if stop and target hit the same day, invalidated
(not a loss) if the stop breaks before the trigger, trigger window 10 sessions, half at T1 then breakeven,
time stop 30 sessions. Results in R, plus MFE/MAE. The Scorecard groups them by setup, grade and regime
and labels the edge (needs ≥ 15 closed): positive (avg ≥ 0.25R), thin, negative.

## Settings

`config.yaml` → `swing:` (see `config.yaml.example`), overridden from the tab (Risk settings →
`data/swing/settings.json`). Detector thresholds: `swing.setup_params`.

## Files

`data/swing/candles/*.pkl` (candle store + `_meta.json`), `data/swing/nse/` (bhavcopies, equity list,
intel), `data/swing/last_run.json`, `data/swing/settings.json`.
