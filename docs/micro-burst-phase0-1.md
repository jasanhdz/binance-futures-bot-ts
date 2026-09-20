# Micro Burst Phases 0-1

This document records the current research boundary. It does not authorize a LIVE
strategy change.

## Safety State

- The deployed reference remains commit `88199bcbeffe0008d2a8e1070cf0fa6aa9aedd9e`.
- No entry pause, PM2 restart, journal mutation, checkpoint update, or exchange order
  is part of this work.
- Offline comparisons are decision-quote marks only. They are not executed PnL and
  must not be described as a time-ablation experiment.
- `economicEvidenceEligible` remains `false` for the offline comparator.

## Phase 0 Result

The read-only script `scripts/micro-burst-phase0-settlement.py` reconstructs exact
order fills from the local SQLite ledger and verifies gross PnL, commissions, funding,
flat quantity, and stored net PnL. The SQLite records are local exports derived from
Binance exact orders/trades/income evidence; this run did not query Binance and must
not be described as a current exchange response.

| Trade | Status | Order identity / fill identity | Coverage | Gross | Fees | Funding | Net |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| SUIUSDT | `VERIFIED_LOCAL_EVIDENCE` | SELL `41155311711` (fills `1569636528`-`1569636535`); BUY `41155344802` (fill `1569639034`) | 9 fills, flat 779, fills/funding/orders complete | 0.3895 | 0.63328805 | 0 | -0.24378805 |
| LTCUSDT | `VERIFIED_LOCAL_EVIDENCE` | SELL `44145629152` (fills `1367246309`-`1367246313`); BUY `44145636106` (fills `1367246588`-`1367246595`) | 13 fills, flat 10.710, fills/funding/orders complete | -0.05250998 | 0.62715134 | 0 | -0.67966132 |
| DOGEUSDT | `VERIFIED_LOCAL_EVIDENCE` | SELL `102815154431` (fills `3472176778`-`3472176792`); BUY `102815205935` (fills `3472178618`-`3472178623`) | 21 fills, flat 6877, fills/funding/orders complete | -1.65048 | 0.61040250 | 0 | -2.26088250 |
| AVAXUSDT | `VERIFIED_LOCAL_EVIDENCE` | SELL `40633913065` (fills `1429562934`-`1429562941`); BUY `40634104301` (fill `1429570999`) | 9 fills, flat 58, fills/funding/orders complete | 1.334 | 0.5408790 | 0 | 0.7931210 |
| XRPUSDT | `VERIFIED_LOCAL_EVIDENCE` | BUY `160478748267` (fills `3308966803`-`3308966806`); SELL `160478880536` (fill `3308969833`) | 5 fills, flat 398.5, fills/funding/orders complete | -0.4782 | 0.57057228 | 0 | -1.04877228 |
| ADAUSDT | `NO_EVALUABLE` | No order/fill identity found for the screenshot | No matching September 18 durable-journal settlement | n/a | n/a | n/a | n/a |

All five verified rows carry source `BINANCE_EXACT_ORDERS_TRADES_AND_INCOME_V1` in
the local evidence. `fundingComplete=true` and funding is an empty set for these
rows. Gross, fees, funding, and net are each read/derived once from that evidence;
the script does not combine them with a live query or count a fee/funding event a
second time. The exit labels are journal/replay evidence, not proof that the exact
settlement order was caused by a simulated stop. In particular, DOGE requires a
separate stop/close-path reconciliation.

The evidence is sufficient to state what was recorded and settled. It is not
sufficient to claim strategy profitability or to infer that an offline exit would
have received the same fill.

## Meaning Of “No Discrepancies”

`scripts/micro-burst-phase01-audit.ts` replays the recorded reducer observations
against their embedded policy/config snapshots:

- SUI: 19/19 recorded decisions reproduced.
- LTC: 4/4 reproduced.
- DOGE: 2/2 reproduced.
- AVAX: 13/13 reproduced.
- XRP: 4/4 reproduced.
- ADA: no matching journal entry.
- No mismatches were reported.

Here “no discrepancies” means that the replay produced the same recorded action and
reason for every captured reducer observation under its embedded policy/config
snapshot. It does not demonstrate profitability, correct exchange execution,
alternative fills, continuous stop behavior, or what the offline variant would have
done with an order book that was not observed. This distinction is preserved in the
audit output as `RECORDED_DECISIONS_REPRODUCED`.

Coverage is limited to recorded reducer observations. It does not model continuous
stop triggers, exchange acknowledgement timing, fills after stop moves, or
post-close paths.

## Comparator Coverage Matrix

| Concern | Code | Regression test | Limitation |
| --- | --- | --- | --- |
| Future information | `MicroBurstOfflineExitComparison.ts:101-109`, `:43-49` | `MicroBurstOfflineExitComparison.test.ts:47-61`, `:63-67` | Rejects future timestamps, but cannot recover missing exchange causality. |
| Input freshness | `MicroBurstOfflineExitComparison.ts:43-49` | `MicroBurstOfflineExitComparison.test.ts:47-61` | Uses timestamp/gap thresholds and residual cost; freshness is not a transport/latency simulator. |
| Decision vs execution | `MicroBurstOfflineExitComparison.ts:22-32`, `:54-60` | `MicroBurstOfflineExitComparison.test.ts:38-45` | Quote-marked outcomes are never execution evidence; no fill simulator exists. |
| Repeated observations | `MicroBurstOfflineExitVariant.ts:276-284` | `MicroBurstOfflineExitVariant.test.ts:193-209` | Same market-evidence timestamp cannot increment confirmation; distinct timestamps may still contain correlated data. |
| Stops, protection moves, extensions | `MicroBurstOfflineExitComparison.ts:146-173`, `:196-200` | Existing variant/comparator tests cover incomplete/unmodeled paths | A stop ACK, trigger, fill, protection move, and destination extension are not simulated; result becomes `UNMODELED_MANAGEMENT`. |
| Fees/funding counted once | `scripts/micro-burst-phase0-settlement.py:38-55` | Script output plus `BinanceAdapter.settlement.test.ts` | Applies only to local settlement evidence; comparator accepts residual cost as an input and does not calculate exchange fees/funding. |
| Incomplete data => `NO_EVALUABLE` | `MicroBurstOfflineExitComparison.ts:88-114`, `:196-220`; settlement script | `MicroBurstOfflineExitComparison.test.ts:38-61`, `:97-103` | `NO_EVALUABLE` is conservative; it does not estimate the missing path. |

The research comparator therefore rejects or marks incomplete when it sees:

- missing, stale, future, non-finite, or insufficient executable economics;
- inconsistent chronology or trade identity;
- repeated evidence presented as a new deterioration observation;
- stop-management or destination-management paths that are not simulated.

The variant state tracks the timestamp of the last market-evidence observation so a
new evaluation clock cannot confirm the same evidence twice.

## Validation Record

- Isolated base reproduction: detached worktree at `88199bc`; `18 passed, 2 failed`.
- Both base failures are the same `TradingService.ts` digest mismatch: expected
  `be754352a4f6c21a4bb6e41239994e004ae398486f7388fa3304a65748bb500f`, received
  `177560d9537fdc1df9464cbec475e59b2271949ed27c99030b90b333ba0b2f48`.
- Full serial command: `npx vitest run --maxWorkers=1 --minWorkers=1 --no-file-parallelism`.
- Full serial result: exit code `1`; `227/228` files passed; `3028/3030` tests passed;
  the same two digest tests failed; no runner error occurred.
- `npm run build`: passed.
- `git diff --check`: passed before final documentation/commit review.

## TODO

- Reconcile the exact DOGE stop/close sequence from exchange order and income data.
- Locate or formally classify the ADA screenshot as external evidence only.
- Add a fixture-backed six-trade phase-0 report if source exports are made available
  without relying on the local runtime ledger.
- Decide the future exit-signal output contract before any implementation work.
- Define a separate continuous stop/fill simulator before comparing managed exits.
- Only after those items: review whether any research result warrants a paper-mode
  experiment. No LIVE activation is implied.
