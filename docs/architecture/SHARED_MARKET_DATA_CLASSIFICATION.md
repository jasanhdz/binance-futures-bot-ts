# Shared Market Data Classification — Baseline Inventory

**Status:** BASELINE AUDIT FOR MIGRATION  
**Reviewed SHA:** `f39215fd4a2c89d3cbbf32c84ea204486fc65e21`  
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

| Path | Classification | Decision |
| --- | --- | --- |
| `src/app/ports/MarketData.ts` | GENERIC_RAW_STATE / CONTRACT | Keep as existing broad compatibility capability. Introduce granular ports rather than endlessly widening it. |
| `src/infra/adapters/MarketDataHub.ts` | GENERIC_TRANSPORT | Keep. It already shares one raw socket per route+stream among consumers. Do not build a second hub. |
| `src/infra/adapters/MarketDataEndpoints.ts` | GENERIC_TRANSPORT | Keep as endpoint/routing authority. |
| `src/infra/adapters/WebSocketManager.ts` | GENERIC_TRANSPORT / COMPATIBILITY | Audit consumers. Do not refactor as collateral during order-book extraction. |
| `src/infra/adapters/BinanceAdapter.ts` market reads | GENERIC_TRANSPORT / READ-ONLY ADAPTER | Reuse read-only market methods; do not expose mutation surface to core market-data. |

## 3. Micro Burst files containing generic market mechanics

### `src/app/micro-burst/MicroBurstMarketData.ts`

**Classification:** `MIXED_SPLIT_REQUIRED` leaning strongly `GENERIC_RAW_STATE`.

Contains normalized feed envelopes/parsers for:

- AggTrade;
- depth diff;
- feed/gap identity.

These facts do not inherently belong to Micro Burst. Extract/alias into shared contracts. Preserve current field meaning and two-clock information.

**Wave:** E/I.

### `src/domain/strategies/micro-burst/SynchronizedOrderBook.ts`

**Classification:** `MIXED_SPLIT_REQUIRED`.

Generic mechanics:

- snapshot loading;
- diff buffering;
- update-ID bridge;
- predecessor chain;
- freshness;
- health;
- gap/resync;
- canonical sorted depth.

Neutral features currently embedded:

- top-5 signed imbalance observation;
- best bid/ask quantities;
- top-5 totals;
- spread bps;
- temporal history bookkeeping.

Micro Burst coupling:

- imports strategy types;
- logger messages named Micro Burst;
- feature-depth constants/types currently live in Micro Burst market-data types;
- `getSnapshotForPressure` is named around a Micro Burst consumer.

**Decision:** extract generic synchronization/state first. Preserve neutral temporal observations if needed for parity, but expose them under neutral names. Do not move the downstream Micro Burst pressure interpretation.

**Wave:** F/G/H.

### `src/domain/strategies/micro-burst/MicroBurstAggTradeBuffer.ts`

**Classification:** `GENERIC_RAW_STATE + GENERIC_NEUTRAL_FEATURE` under a strategy-specific name.

Generic mechanics:

- rolling event-time retention;
- aggregate identity continuity;
- pending gap qualification;
- out-of-order insertion;
- missing identity;
- persisted gap lookup;
- reconnect uncertainty;
- capacity truncation;
- window completeness.

Neutral summary:

- buy/sell volume;
- net taker volume;
- trade count;
- observed/requested window;
- coverage/quality diagnostics.

**Decision:** extract after order-book Wave 1. Maintain a Micro Burst compatibility wrapper/re-export until consumers migrate.

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

**Decision:** defer until benchmark Wave N. Do not pull into Wave 1.

### `MicroBurstReferencePrice.ts`

**Classification:** `MIXED / DEFER`.

Generic facts such as bid/ask/mid/mark should be shared. The preference/fallback order used as a strategy reference may be policy. Audit before extracting.

**Wave:** L.

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

## 8. Wave 1 migration map

| Current | Target concept | Compatibility expectation |
| --- | --- | --- |
| neutral depth types in MB files | shared depth contracts | MB re-export/adapter allowed |
| `SynchronizedOrderBook` | shared synchronized order-book provider | old name remains reference/wrapper until parity |
| MB order-book health/state types | shared health/state types | no semantic reinterpretation |
| temporal raw book observations | neutral book observations if required | pressure interpretation remains MB |
| `MicroBurstBookPressureAnalyzer` | stays Micro Burst | no move |

## 9. Wave 2 migration map

| Current | Target concept | Compatibility expectation |
| --- | --- | --- |
| `AggTradeEvent` under MB namespace | shared normalized AggTrade event | field parity |
| `MicroBurstAggTradeBuffer` | shared rolling AggTrade state | MB wrapper/reference until parity |
| `getTakerFlow()` neutral summary | shared flow-window summary | exact units/coverage semantics |
| MB-specific use of flow | stays Micro Burst | no strategy behavior change |

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
