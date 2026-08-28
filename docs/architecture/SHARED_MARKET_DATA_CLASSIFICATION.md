# Shared Market Data Classification — Baseline Inventory

**Status:** BASELINE AUDIT FOR MIGRATION  
**Reviewed SHA:** `26dbf822ecfa1b2607199da393c55b8de697b844`
**Purpose:** classify current market-data-related code before extraction so generic mechanics are moved without accidentally moving strategy meaning.

## 1. Classification vocabulary

- `GENERIC_TRANSPORT` — exchange connectivity/fan-out independent of strategy.
- `GENERIC_RAW_STATE` — normalized market facts, synchronization, continuity, freshness, buffering.
- `GENERIC_NEUTRAL_FEATURE` — deterministic feature whose definition does not encode a strategy thesis.
- `STRATEGY_SPECIFIC` — interpretation/policy that belongs to a strategy.
- `MIXED_SPLIT_REQUIRED` — file contains both reusable market mechanics and strategy-specific semantics.
- `COMPATIBILITY` — existing API/path should remain temporarily while consumers migrate.
- `DEFER` — potentially shareable later, but not part of the first extraction waves.

## 2. Existing shared foundation

| Path                                                | Classification                        | Decision                                                                                                     |
| --------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/app/ports/MarketData.ts`                       | GENERIC_RAW_STATE / CONTRACT          | Keep as existing broad compatibility capability. Introduce granular ports rather than endlessly widening it. |
| `src/infra/adapters/MarketDataHub.ts`               | GENERIC_TRANSPORT                     | Keep. It already shares one raw socket per route+stream among consumers. Do not build a second hub.          |
| `src/infra/adapters/MarketDataEndpoints.ts`         | GENERIC_TRANSPORT                     | Keep as endpoint/routing authority.                                                                          |
| `src/infra/adapters/WebSocketManager.ts`            | GENERIC_TRANSPORT / COMPATIBILITY     | Audit consumers. Do not refactor as collateral during order-book extraction.                                 |
| `src/infra/adapters/BinanceAdapter.ts` market reads | GENERIC_TRANSPORT / READ-ONLY ADAPTER | Reuse read-only market methods; do not expose mutation surface to core market-data.                          |

## 3. Micro Burst files containing generic market mechanics

### `src/core/market-data/SynchronizedOrderBook.ts`

**Classification:** `GENERIC_RAW_STATE`.

Owns the extracted synchronized USD-M order-book mechanics, including snapshot bridging,
update-ID continuity, freshness, fail-closed health, bounded levels, and neutral temporal
observations. It has no strategy dependency.

### `src/core/market-data/OrderBookDataPlane.ts`

**Classification:** `GENERIC_RAW_STATE`.

Owns one canonical order-book instance per normalized symbol and reference-counted
consumer leases. It exposes only the read-only `OrderBookPort` capability and owns
start/stop lifecycle transitions.

### `src/core/market-data/OrderBookQuoteProvider.ts`

**Classification:** `GENERIC_RAW_STATE + GENERIC_NEUTRAL_FEATURE`.

Derives an immutable bid/ask/mid/spread quote from an existing canonical
`OrderBookPort`. It preserves the source book health and observed receive timestamp,
fails closed for unavailable, stale, unsynchronized, empty, invalid, or crossed
source state, and does not create a quote subscription or ownership plane.

### `src/core/market-data/MarketDataCandleProvider.ts`

**Classification:** `GENERIC_RAW_STATE + CONTRACT`.

Wraps the existing REST `getCandles` and `getServerTime` capabilities into a
read-only `CandlePort`. It adds explicit interval identity, OPEN/CLOSED status at
the exchange-time boundary, local response observation time, OHLCV validation,
freshness, and deterministic gap diagnostics. Fixed production intervals and
calendar-aware `1M` continuity are checked; other intervals report
`gapCheck: UNSUPPORTED` rather than claiming gap-free data.

This provider is REST-only. Wave N wires one instance into the existing Micro
Burst BTC polling lifecycle; the existing `BinanceAdapter` candle cache and 5m
WS path, including its AggTrade `buyVolume` overlay, remain compatibility
behavior and are unchanged.

### `src/core/market-data/BenchmarkMarketData.ts`

**Classification:** `GENERIC_RAW_STATE + CONTRACT`.

Defines an immutable generic benchmark descriptor and a read-only composition
over existing symbol capabilities. It normalizes benchmark identity and reuses
the supplied `CandlePort`, `QuotePort`, and `OrderBookPort`; it owns no feed,
subscription, buffer, or polling lifecycle. AggTrade availability remains in
the existing shared `AggTradeDataPlane` and is not forced into Micro Burst by
this phase.

**Wave:** N.

### `src/core/market-data/SharedNeutralMarketFeatures.ts`

**Classification:** `GENERIC_NEUTRAL_FEATURE`.

Defines schema-versioned, immutable, pure calculators for quote spread, top-5
and top-10 order-book facts, complete rolling AggTrade flow, and closed-candle
returns. Source quality and causal timestamps travel with every family; no
strategy interpretation, lifecycle authority, or I/O is introduced.

**Wave:** O.

### `src/core/market-data/RollingAggTradeBuffer.ts`

**Classification:** `GENERIC_RAW_STATE + GENERIC_NEUTRAL_FEATURE`.

Owns event-time retention, aggregate-trade continuity, pending and persisted gap
qualification, reconnect uncertainty, capacity limits, window coverage, and neutral
taker-flow summaries without strategy interpretation.

### `src/core/market-data/AggTradeDataPlane.ts`

**Classification:** `GENERIC_RAW_STATE`.

Owns one canonical rolling AggTrade state and one normalized subscription per symbol
through reference-counted consumer leases. It exposes no execution or mutation authority.

### `src/app/micro-burst/MicroBurstMarketData.ts`

**Classification:** `MIXED_SPLIT_REQUIRED` leaning strongly `GENERIC_RAW_STATE`.

Contains normalized feed envelopes/parsers for:

- AggTrade;
- depth diff;
- feed/gap identity.

These facts do not inherently belong to Micro Burst. Extract/alias into shared contracts. Preserve current field meaning and two-clock information.

**Wave:** E/I.

### `src/domain/strategies/micro-burst/SynchronizedOrderBook.ts`

**Classification:** `COMPATIBILITY`.

Delegates to the shared implementation and retains only the Micro Burst
`getSnapshotForPressure` compatibility name and legacy output types.

**Decision:** keep this wrapper until parity and runtime qualification are complete. Do not move
the downstream Micro Burst pressure interpretation.

**Wave:** G/H.

### `src/domain/strategies/micro-burst/MicroBurstAggTradeBuffer.ts`

**Classification:** `COMPATIBILITY`.

Delegates to the shared rolling buffer while preserving the legacy constructor and class name.

**Decision:** retain this wrapper until shared AggTrade parity and runtime qualification are complete.

**Wave:** I/J/K.

### `src/domain/strategies/micro-burst/MicroBurstMarketDataTypes.ts`

**Classification:** `MIXED_SPLIT_REQUIRED`.

Expected to contain both neutral source/state types and Micro Burst-specific feature/context types. Split by semantics, not by mechanical renaming.

**Wave:** C–K incrementally.

## 4. Files that should remain Micro Burst-specific

### `MicroBurstBookPressureAnalyzer.ts`

**Classification:** `STRATEGY_SPECIFIC`.

Although it consumes generic depth facts, its pressure/absorption/sweep interpretation is part of Micro Burst's thesis. Do not move wholesale into shared market-data.

If a primitive formula is later shown to be neutral and reused, extract the primitive separately with a versioned definition.

### `MicroBurstMomentumAnalyzer.ts`

**Classification:** `STRATEGY_SPECIFIC`.

Momentum interpretation belongs to Micro Burst unless a future neutral primitive is separately identified.

### `MicroBurstContextBuilder.ts`

**Classification:** `STRATEGY_SPECIFIC COMPOSITION`.

It assembles the exact context Micro Burst needs. After shared extraction it should consume shared ports, but it remains Micro Burst-owned.

### `MicroBurstEntryPolicy.ts`, `MicroBurstExitPolicy.ts`

**Classification:** `STRATEGY_SPECIFIC`.

Never move into market-data core.

### `MicroBurstMicroRegime.ts`

**Classification:** `STRATEGY_SPECIFIC`.

Regime interpretation is strategy meaning.

### `MicroBurstDuplicateSignalGuard.ts`

**Classification:** `STRATEGY_SPECIFIC / DECISION LIFECYCLE`.

Not a market-data concern.

## 5. Mixed/deferred components

### `BtcMicroContextProvider.ts` and `MicroBurstBtcContext.ts`

**Classification:** `MIXED_SPLIT_REQUIRED`.

Potentially shared:

- BTC raw candles/quote/order-book/AggTrade availability;
- neutral BTC returns with explicit windows/units if definition is canonical.

Micro Burst-specific:

- direction thresholds;
- acceleration interpretation if tied to MB assumptions;
- conflict semantics against a candidate side.

**Wave N status:** `BtcMicroContextProvider` now consumes the generic benchmark
composition and qualified `CandlePort`. Its candle buffer, return windows,
acceleration, direction threshold, freshness behavior, and lifecycle remain
Micro Burst-specific. `MicroBurstBtcContext` continues to own candidate-side
conflict interpretation and thresholding.

### `MicroBurstReferencePrice.ts`

**Classification:** `MIXED / DEFER`.

Generic facts such as bid/ask/mid/mark should be shared. The preference/fallback order used as a strategy reference may be policy. Audit before extracting.

**Wave:** L.

**Wave 3A decision:** leave the provider unchanged. Its midpoint-first and mark-price
fallback ordering remains Micro Burst policy; the neutral quote capability is
available independently for future composition.

### `MicroBurstSupportResistance.ts`

**Classification:** `DEFER / POSSIBLY NEUTRAL STRUCTURE`.

Causal pivots and raw levels could be shared later. Thresholds such as room sufficiency remain strategy-specific.

Not part of Wave 1 or Wave 2.

### `MicroBurstStorage.ts` and market archive

**Classification:** `DEFER / RESEARCH INFRASTRUCTURE`.

Existing archives are valuable and must be preserved. Do not make storage refactoring a prerequisite for shared in-memory market state.

## 6. Other current market-data consumers

### `LiquidityVoidDetector`

Uses shared partial-depth transport through existing runtime infrastructure. It demonstrates why raw transport is already broader than Micro Burst.

**Decision:** regression-test it; do not force it to migrate to synchronized full/diff book state unless there is a separate requirement.

Partial-depth snapshots and synchronized diff-depth books are related but not identical products. Do not merge their semantics casually.

### `TradingService`

Large orchestration hotspot with many LIVE responsibilities.

**Decision:** avoid broad edits. Shared market-data composition should be introduced through small seams/factories rather than using this program as a reason to refactor TradingService.

## 7. Target ownership after Waves 1–4

```text
src/app/ports or src/core/market-data
  neutral contracts / capabilities

src/infra/adapters or src/infra/market-data
  Binance/read-only transport and provider implementations

shared synchronized order-book state
  no concrete strategy dependency

shared AggTrade rolling state
  no concrete strategy dependency

Micro Burst
  context builder
  pressure interpretation
  momentum interpretation
  BTC conflict interpretation
  entry/exit policy

Aegis
  unchanged decision inputs until future explicit experiment

Momentum
  unchanged decision inputs until future explicit experiment
```

Exact paths are intentionally not frozen if they conflict with repository conventions. Dependency direction and ownership semantics are frozen.

## 12. Wave 3C Phase N status

**Status:** COMPLETE — local verification passed; exact-SHA CI remains external.

Phase N provides generic benchmark identity and read-only composition over the
existing candle, quote, and order-book capabilities. BTC is represented by
`PRIMARY_CRYPTO_BENCHMARK -> BTCUSDT`; no BTC-specific shared provider or
duplicate transport was added. Micro Burst remains the only consumer migrated
to the shared candle capability, and its BTC interpretation remains strategy
owned. Phase O neutral features and the future snapshot layer are not included.

## 8. Wave 1 migration map

| Current                          | Target concept                          | Compatibility expectation                       |
| -------------------------------- | --------------------------------------- | ----------------------------------------------- |
| neutral depth types in MB files  | shared depth contracts                  | MB re-export/adapter allowed                    |
| `SynchronizedOrderBook`          | shared synchronized order-book provider | old name remains reference/wrapper until parity |
| MB order-book health/state types | shared health/state types               | no semantic reinterpretation                    |
| temporal raw book observations   | neutral book observations if required   | pressure interpretation remains MB              |
| `MicroBurstBookPressureAnalyzer` | stays Micro Burst                       | no move                                         |

## 9. Wave 2 migration map

| Current                            | Target concept                   | Compatibility expectation         |
| ---------------------------------- | -------------------------------- | --------------------------------- |
| `AggTradeEvent` under MB namespace | shared normalized AggTrade event | field parity                      |
| `MicroBurstAggTradeBuffer`         | shared rolling AggTrade state    | MB wrapper/reference until parity |
| `getTakerFlow()` neutral summary   | shared flow-window summary       | exact units/coverage semantics    |
| MB-specific use of flow            | stays Micro Burst                | no strategy behavior change       |

## 10. Important historical documentation caveat

`docs/strategies/micro-burst/M1_MARKET_DATA_PLANE_REPORT.md` records an earlier version of the synchronization algorithm. Later correctness work changed/qualified details, including the current bridge and `pu` continuity semantics.

Implementation MUST use the current tested code and latest qualification evidence as the oracle, not copy old prose blindly.

Similarly, `M3_2_3_SHARED_DEPTH_TRANSPORT_REPORT.md` confirms `MarketDataHub` and shared transport topology already exist. This architecture should build on that topology rather than duplicating it.

## 11. Classification stop rule

If Codex discovers a file categorized here differently from actual runtime behavior, it must:

1. document the evidence;
2. update this classification in the implementation change if material;
3. avoid moving the code until ownership is understood;
4. never infer “shared” merely because two strategies could theoretically use it.

A component is shared because its semantics are strategy-neutral, not because reuse sounds aesthetically attractive.

## 13. Wave 4A Phase O status

**Status:** COMPLETE — local verification pending final commit and exact-SHA CI.

`src/core/market-data/SharedNeutralMarketFeatures.ts` defines the immutable
`SHARED_MARKET_FEATURES_V1` contract and pure calculators for quote spread,
top-level order-book facts, complete rolling AggTrade flow, and closed-candle
returns. It has no I/O, lifecycle authority, strategy dependency, or mutation
authority. The durable formula and unit source of truth is
`docs/architecture/SHARED_MARKET_FEATURES_V1.md`.

Phase O does not migrate Aegis, Momentum, or Micro Burst consumers and does not
implement `MarketSnapshotProvider`, Black Box collection, persistence, or ML.
