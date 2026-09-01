# Shared Market Data Architecture V1

**Status:** DESIGN SOURCE OF TRUTH  
**Baseline reviewed:** `f39215fd4a2c89d3cbbf32c84ea204486fc65e21`  
**Scope:** market-data ownership, causal state, neutral features, strategy consumption, and future research snapshots.  
**Non-goal:** this document does not authorize any LIVE strategy change, exchange mutation, model gate, or strategy tuning.

## 1. Purpose

The trading system currently contains reusable market facts whose lifecycle is still partially strategy-named, especially around Micro Burst. The purpose of Shared Market Data V1 is to make market reality a strategy-independent capability while preserving every strategy's right to interpret that reality differently.

The architectural rule is:

> Shared market-data layers describe **what the market is doing**. Strategies decide **what it means**.

Order-book synchronization, AggTrade continuity, candle retrieval, quotes, timestamps, freshness, and benchmark observations are market-data concerns. Concepts such as `btcConflict`, `burstDetected`, `roomSufficient`, Aegis EQM/TRRM/QMAE, or Momentum continuation are strategy semantics and must not move into the shared layer merely because they use shared data.

## 2. Current baseline

The repository already has useful shared foundations:

- `src/app/ports/MarketData.ts` exposes a neutral `MarketDataPort` with candles, depth diff, AggTrades, snapshots, mark price, funding, and basis.
- `src/infra/adapters/MarketDataHub.ts` already fans out one raw WebSocket stream to multiple consumers and owns reconnect/watchdog behavior.
- `src/infra/adapters/MarketDataEndpoints.ts` owns the environment-specific routing descriptors.
- Micro Burst currently owns strategy-named normalized feed envelopes, synchronized book state, AggTrade rolling continuity, and several market-derived analyzers.

Therefore this project MUST NOT create a second WebSocket hub or a second competing transport plane. The migration is an extraction and normalization of reusable state above strategies, not a rewrite of transport that already works.

## 3. Target dependency direction

```text
Binance / external market sources
            |
            v
+-------------------------------+
| Shared transport / adapters   |
| MarketDataHub + REST adapters |
+---------------+---------------+
                |
                v
+-----------------------------------------------+
| Shared Market Data Plane                      |
| candles | quotes | order book | AggTrades     |
| benchmark raw data | source quality / clocks  |
+-----------------------+-----------------------+
                        |
                        v
+-----------------------------------------------+
| Shared Neutral Market Features                |
| spread, depth, imbalance, raw taker flow,     |
| trade rate, simple returns/ATR when canonical |
+-----------------------+-----------------------+
                        |
       +----------------+----------------+
       |                |                |
       v                v                v
     AEGIS          MOMENTUM        MICRO BURST
 strategy logic     strategy logic    strategy logic
       |                |                |
       +----------------+----------------+
                        |
                        v
             strategy decisions / shadow
                        |
                        v
             Strategy Decision Black Box
                  (observational only)
```

## 4. Layer model

### Layer 0 — transport

Owns connectivity and wire delivery only.

Examples:

- `MarketDataHub`
- endpoint selection
- REST requests
- raw WebSocket reconnect/watchdog
- fan-out of one raw stream to N consumers

Transport MUST NOT contain strategy policy.

### Layer 1 — canonical raw/normalized market state

Owns normalized facts and data-quality state.

Capabilities should be granular and read-only. The eventual contracts may be named differently if repository conventions require it, but conceptually include:

- `CandlePort`
- `QuotePort`
- `OrderBookPort`
- `AggTradePort`
- `BenchmarkMarketDataPort`

A strategy should depend only on the capabilities it actually needs. There must not be one mandatory `MarketContextGodObject` that forces Aegis, Momentum, and Micro Burst to initialize every feed.

### Layer 2 — shared neutral features

May calculate only definitions that remain useful if every current strategy were deleted.

Good candidates:

- best bid / best ask / midpoint
- spread and spread bps
- depth by fixed neutral distance or fixed top-N definition
- signed top-N imbalance
- AggTrade buy volume / sell volume / net taker volume
- trade count / rate
- source age / coverage / continuity
- simple candle returns
- ATR only after a canonical definition is explicitly versioned

A shared feature must have a versioned definition and unit contract. If two strategies legitimately need different definitions, the feature should stay strategy-specific or the shared layer should expose lower-level primitives instead.

### Layer 3 — strategy interpretation

Must remain owned by each strategy.

Micro Burst examples:

- burst detection
- continuation score
- entry extension semantics
- `roomSufficient`
- `btcConflict`
- Micro Burst book-pressure interpretation
- proof window / early failure
- structural invalidation policy
- BE / trailing / max hold

Momentum examples:

- momentum thesis
- continuation/persistence thresholds
- strategy-specific confirmation

Aegis examples:

- EQM / TRRM / QMAE
- expected return
- Aegis guard interpretation
- strategy-specific regime or risk decisions

## 5. Order book ownership

The synchronized order book is market state, not Micro Burst state.

The shared order-book provider must own:

- diff buffering
- REST snapshot bridge
- Binance update-ID continuity
- `pu` predecessor validation after synchronization
- stale detection
- crossed/empty-book rejection
- gap accounting
- resynchronization/backoff
- canonical receive timestamp
- bounded depth state
- health: `HEALTHY | UNAVAILABLE | STALE | UNSYNCED | ANOMALOUS`

The already-qualified Binance USD-M continuity semantics are frozen during extraction:

1. Buffer diff events while snapshot is acquired.
2. Discard stale events before the snapshot boundary according to the currently qualified implementation.
3. The bridge event must cover the snapshot update ID.
4. After synchronization, each new event must chain through `pu == previous u`.
5. Duplicate/stale updates are ignored safely.
6. Gap, malformed data, crossed book, reconnect uncertainty, or stale state fails closed and triggers resynchronization.

Extraction MUST be demonstrated by parity tests against the current `SynchronizedOrderBook`; it must not be reinterpreted from memory or from an obsolete M1 report.

### Order-book consumers

At initial migration:

- Micro Burst: consumes it for decisions exactly as today.
- Aegis: no decision dependency is added.
- Momentum: no decision dependency is added.
- Black-box/research snapshot: may observe it later without influencing decisions.

Availability is not authority. Exposing `OrderBookPort` to composition does not mean every strategy must use it.

## 6. AggTrade ownership

Raw AggTrade history and continuity are market-data concerns.

The shared AggTrade provider/buffer must preserve the current qualified behavior for:

- aggregate-trade identity
- duplicate/out-of-order handling
- pending-gap qualification
- missing-identity fail-closed behavior
- event-time retention
- window coverage
- capacity truncation
- persisted-gap lookup where used
- reconnect continuity invalidation
- fresh complete-window requirement before readiness

Neutral outputs may include:

- recent normalized AggTrades
- buy volume
- sell volume
- net taker volume
- trade count
- requested/observed window
- coverage start
- `windowComplete`
- `gapFree`
- `capacityTruncated`

Micro Burst-specific interpretation of that flow stays in Micro Burst.

## 7. Candles, quotes, and reference prices

Candles are inherently shared market data. The architecture should converge toward a strategy-neutral candle capability with explicit closed/open status, source timestamp, receive timestamp where available, freshness, and gap semantics.

Quotes must distinguish at least:

- best bid
- best ask
- midpoint
- observed/received time
- health

Do not collapse mark price, last trade, midpoint, and executable bid/ask into one ambiguous `currentPrice`.

A strategy may choose a strategy-specific reference-price fallback. The shared layer provides facts; fallback preference is policy unless a system-wide execution contract explicitly standardizes it.

## 8. Benchmark data

BTC and other benchmark symbols are not Micro Burst-owned data.

Shared layer may expose raw benchmark facts such as:

- BTC candles
- BTC quote
- BTC returns if defined neutrally
- BTC AggTrades
- BTC order book

But `BTC conflicts with this ETH LONG` is a strategy interpretation and must remain strategy-specific.

## 9. Structure and support/resistance

Causal pivots and structural levels may eventually become shared neutral features if the implementation and definition are truly strategy-independent. This is intentionally deferred until after order-book, AggTrade, quote, candle, and benchmark extraction.

`room sufficient`, breakout validity, retest validity, or entry geometry thresholds are not shared facts.

## 10. Time and causality contract

Every shared source must preserve two different concepts where available:

- **exchange/event time:** when the exchange says the market event occurred;
- **local receive time:** when the process could first causally know the event.

No shared service may silently compare these clock domains as if they were interchangeable.

For online decision causality and black-box snapshots, the availability boundary is local receive time. Exchange time remains market chronology/provenance.

A `MarketSnapshot` captured at receive time `t` may contain only source state that was causally available at or before `t`.

## 11. Quality contract

A market-data capability must expose quality instead of fabricating fallbacks.

Canonical vocabulary should converge toward:

- `HEALTHY`
- `STALE`
- `UNSYNCED`
- `UNAVAILABLE`
- `ANOMALOUS`

A shared state may be absent. Consumers must handle absence/quality explicitly. No empty book, fake quote, zero flow, or stale benchmark may be silently presented as valid market evidence.

## 12. Snapshot architecture

The future `MarketSnapshotProvider` is an assembler over granular capabilities, not the owner of the feeds.

A conceptual snapshot:

```ts
interface MarketSnapshot {
  schemaVersion: number;
  snapshotId: string;
  symbol: string;
  capturedAtReceivedMs: number;
  quote?: MarketQuoteSnapshot;
  candles?: Record<string, CandleWindowSnapshot>;
  orderBook?: OrderBookSnapshot;
  aggTradeFlow?: AggTradeWindowSnapshot;
  benchmarks?: Record<string, BenchmarkSnapshot>;
  sharedFeatures?: SharedMarketFeatureSnapshot;
  provenance: MarketSnapshotProvenance;
}
```

The actual implementation must not make every field mandatory. Snapshot requests should declare requested capabilities so that Aegis does not become operationally dependent on order book merely because research wants to observe it.

The provider must record per-source timestamp/quality. A single `snapshotAt` is not sufficient proof that all underlying data was equally fresh.

## 13. Strategy capability model

The desired composition is declarative and optional.

Example conceptual state:

```text
AEGIS
  candles: REQUIRED by current strategy
  orderBook: NOT REQUIRED for decision
  AggTrades: NOT REQUIRED for decision
  black-box observation: MAY request them later

MOMENTUM_RIDE
  candles/price: current requirements
  orderBook: NOT REQUIRED for decision
  AggTrades: NOT REQUIRED for decision
  black-box observation: MAY request them later

MICRO_BURST_V1
  candles: REQUIRED
  quote/reference: REQUIRED
  orderBook: REQUIRED
  AggTrades: REQUIRED
  benchmark/BTC: REQUIRED
```

No strategy may be prevented from evaluating solely because an optional research-only capability is missing.

## 14. Black-box boundary

Shared market data is a prerequisite for the future Strategy Decision Black Box, but the black box is not part of decision authority.

Initial information flow is one way:

```text
strategy evaluation + shared market snapshot
                  |
                  v
             black-box log
```

Never:

```text
black-box result -> strategy decision
```

Any future use of learned features in Aegis, Momentum, or Micro Burst requires a separate preregistered experiment, out-of-sample validation, prospective shadow validation, and explicit promotion decision.

## 15. Persistence and storage

The shared online data plane is primarily in-memory state with bounded retention. Research archives are a separate concern.

Do not write a full order-book snapshot per strategy per evaluation. Prefer:

- one shared feed/state;
- compact versioned neutral features at decision time;
- optional centralized market archive where already justified;
- strategy decision records referencing a shared `marketSnapshotId` where practical.

Existing Micro Burst archives and prospective evidence must not be moved, rewritten, or invalidated by this architecture migration.

## 16. Read-only and mutation boundary

`core/market-data` or equivalent shared market-data code must not import or depend on mutation authority such as:

- `TradingExchangePort`
- mutation-capable `Exchange`
- `SharedStrategyExecutionService`
- real position managers
- order/bracket mutation APIs

Adapters may perform public/read-only market-data network operations only.

Architecture tests must enforce this boundary.

## 17. Compatibility rule

During extraction, the current Micro Burst runtime is the behavioral oracle for market-data semantics that have already been qualified.

The migration must use compatibility adapters/aliases and golden parity before removing strategy-named implementations.

Do not perform a large rename-and-move in one commit. First add generic contracts and implementations, then migrate Micro Burst consumers, observe, and only later retire compatibility code.

## 18. Non-goals for V1

V1 does NOT:

- make Aegis use order book;
- make Momentum use order book;
- change any strategy threshold;
- build an entry-quality model;
- create a global strategy vote;
- create an ensemble/router based on shared features;
- alter LIVE ownership/risk/execution;
- replace Binance transport that already works;
- migrate historical evidence paths;
- declare profitability.

## 19. Acceptance invariants

The architecture is considered successfully established only when all are true:

1. One shared order-book state can be read by multiple consumers without strategy ownership.
2. One shared AggTrade state can be read by multiple consumers without strategy ownership.
3. Micro Burst outputs remain parity-equivalent through migration.
4. Aegis and Momentum behavior remain byte/semantic regression-equivalent where applicable.
5. No new exchange mutation authority exists.
6. Receive-time causality is explicit and tested.
7. Reconnect/gap/freshness semantics remain fail-closed.
8. Optional consumers cannot make unrelated strategies unavailable.
9. Shared features contain facts, not strategy policy.
10. The future black box can capture a causal market snapshot without changing strategy decisions.

## 20. Authority

This document is the design source of truth for Shared Market Data V1. The phased implementation sequence and stop/go gates are defined in `SHARED_MARKET_DATA_MIGRATION_PLAN.md`. The current code inventory and migration classification are defined in `SHARED_MARKET_DATA_CLASSIFICATION.md`. The observational research consumer is defined in `../research/STRATEGY_DECISION_BLACKBOX_V2.md`.
