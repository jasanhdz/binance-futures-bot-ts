# M3.2.6.1 Pre-Soak Findings

Base audited SHA: `6faf6ee95e95acc8f2ea7d254d026dae66396c70`

Current implementation SHA at audit time: `3e82a37c2f8bb512b997776929f47ab1c00f224d`

## Audit Record

| Finding | Severity | Status | Evidence | Semantic strategy change |
| --- | --- | --- | --- | --- |
| Binance local-book bridge | P0 | CONFIRMED, FIXED | `SynchronizedOrderBook.syncFromSnapshot()` now uses `U <= lastUpdateId <= u`, drops `u <= lastUpdateId`, and enforces `pu`. | NO |
| Anomalous book recovery | P0 | CONFIRMED, FIXED | `SynchronizedOrderBook.invalidate()` clears state and schedules one guarded, backoff-limited resync. | NO |
| MARKET ambiguity | P0 | CONFIRMED, FIXED | Shared execution retries lookup, position, fill, and order-history reconciliation before returning `MARKET_OPEN_AMBIGUOUS`. | NO |
| Quantity retry identity | P0 | CONFIRMED, FIXED | Definite rejection retries use unique attempt IDs tied to one execution intent; ambiguous attempts reuse the original ID. | NO |
| Margin and leverage verification | P0 | CONFIRMED, FIXED | Binance adapter verifies read-back state and rejects unknown or mismatched results. | NO |
| Exact protection and cleanup | P0 | CONFIRMED, FIXED | Protection matching requires canonical fields and cleanup verifies flatness and bot ownership. | NO |
| Typed gaps and dependencies | P0 | CONFIRMED, FIXED | SQLite migration labels legacy rows `UNKNOWN_LEGACY`; feed dependencies are explicit. | NO |
| Clock domains | P0 | CONFIRMED, FIXED | Event and local receive clocks are separated; offset conversion is tested and ages are bounded. | NO |
| AggTrade completeness | P0 | CONFIRMED, FIXED | Event-time watermark, coverage, gaps, and emergency-cap truncation are exposed and data-quality gated. | NO |
| Episode identity | P0 | CONFIRMED, FIXED | Same-side overlapping 300-second windows use deterministic persisted episode components. | NO |
| Cohort isolation and SQLite authority | P0 | CONFIRMED, FIXED | Analyzer requires explicit selection for multiple cohorts and validates SQLite fields against payloads. | NO |
| Malformed outcome journal rows | P0 | CONFIRMED, FIXED | Malformed file/line/reason/count are exposed and block official readiness. | NO |
| Startup zero-symbol fallback | P0 | CONFIRMED, FIXED | Production startup throws `STARTUP_NO_ACTIVE_SYMBOLS`; no implicit ETH fallback. | NO |
| Daily baseline and state flush | P1 | CONFIRMED, FIXED | UTC daily baseline survives restart; state flush fsyncs file and directory and is awaited on stop. | NO |
| Liquidity freshness | P1 | CONFIRMED, FIXED | Receive age and status are exposed; asymmetric ask diagnostic was corrected. | NO |
| Telegram mutation authorization | P1 | CONFIRMED, FIXED | Chat, user, default-false master flag, and append-only audit are required. | NO |
| Dependency vulnerabilities | P1 | CONFIRMED, OPEN | `npm audit --omit=dev`: 5 high and 1 moderate remain. No blind force upgrade was run. | NO |

## Official Binance Reference

The current reference is Binance USD-M Futures, *How to manage a local order book correctly*:
<https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/How-to-manage-a-local-order-book-correctly>

The endpoint was not returned by the documentation fetcher in this environment. The implementation follows the documented USD-M sequence: discard `u < lastUpdateId`, bridge with `U <= lastUpdateId <= u`, then require `pu == previous u`. The boundary and recovery tests are in `SynchronizedOrderBook.test.ts`.

## Current Gate

`npm run micro-burst:pre-cohort-audit` returns `ready: false`. No official cohort or 900-second soak was started. Fresh manifest, archive/database evidence, healthy books, complete flow warmup, preregistration, and dependency closure are not asserted. The milestone remains `MICRO_BURST_V1_M3_2_6_1_PRE_SOAK_BLOCKED`.
