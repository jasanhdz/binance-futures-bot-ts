# MICRO_BURST_V1 M1 — Market Data Shadow Plane Report

**Branch:** `work/micro-burst-rider-v1-20260826`  
**Status:** COMPLETED  
**Checkpoint:** MICRO_BURST_V1_M1_MARKET_DATA_SHADOW_READY  
**Authority:** SHADOW evaluation only. No LIVE. No exchange mutation.

## 1. Architecture

```
Binance WebSocket (depth/diff + aggTrade)
        │
        ▼
SynchronizedOrderBook ──► MicroBurstContextBuilder ──► MicroBurstShadowEvaluator
        │                         │                              │
        │                    BtcMicroContextProvider              │
        │                         │                              │
        │                    MicroBurstReferencePrice             │
        │                         │                              │
        │                    MicroBurstAggTradeBuffer             │
        │                                                         │
        └──► MicroBurstBookPressureAnalyzer ◄─────────────────────┘
                    (temporal history)
```

All components use injected `Clock` — no `Date.now()` in domain production code.

## 2. Streams Used

| Stream            | Symbol                | Purpose                              | Buffer Size |
| ----------------- | --------------------- | ------------------------------------ | ----------- |
| `depth@100ms`     | Per configured symbol | Order book diffs for synchronization | 500 events  |
| REST `depth`      | Per configured symbol | Full snapshot for initial sync       | N/A         |
| `kline_1m` (REST) | BTCUSDT               | BTC context returns                  | 120 candles |
| `aggTrade`        | Per configured symbol | Taker flow / absorption / sweep      | 200 events  |
| REST `markPrice`  | Per configured symbol | Reference price                      | 1 entry     |

## 3. Synchronization Algorithm

Follows the official Binance Futures depth synchronization:

1. Open `depth@100ms` diff stream, buffer events.
2. Request REST `depth` snapshot, capture `lastUpdateId`.
3. Discard buffered events where `u <= lastUpdateId`.
4. First applied event must satisfy: `U <= lastUpdateId+1` AND `u >= lastUpdateId+1`.
5. Apply diffs sequentially. Detect gaps (`u != lastUpdateId+1`).
6. On gap: mark `UNSYNCED`, resync from REST (max 3 attempts).
7. `qty=0` removes level. Bids descending, asks ascending.
8. Crossed book or invalid data => `ANOMALOUS`.

### Health States

| State         | Meaning                             |
| ------------- | ----------------------------------- |
| `HEALTHY`     | Book synchronized, fresh, valid     |
| `UNAVAILABLE` | No snapshot yet or snapshot failed  |
| `STALE`       | No update for > 10s                 |
| `UNSYNCED`    | Gap detected, awaiting resync       |
| `ANOMALOUS`   | Crossed, malformed, or invalid data |

## 4. Bounded Buffer Sizes

| Buffer                   | Max Size          | Max Age                    |
| ------------------------ | ----------------- | -------------------------- |
| Depth diff buffer        | 500 events        | N/A (processed on sync)    |
| Order book levels        | 20 per side       | N/A                        |
| BTC candle buffer        | 120 candles       | 120s staleness             |
| AggTrade buffer          | 200 events        | 300s                       |
| Duplicate signal history | 500 entries       | 3600s TTL                  |
| Temporal book history    | Managed by caller | Bounded by context builder |

## 5. Temporal Book History

`analyzeBookPressure()` now accepts an optional `temporalHistory: TemporalBookSnapshot[]`.

When history has ≥ 3 observations:

- **`imbalanceSlope`**: Linear regression of top-of-book imbalance over the last `slopeWindow` observations. `null` when insufficient data.
- **`temporalAbsorptionDetected`**: Imbalance spike + qty growth + tight spread across observations.
- **`temporalSweepDetected`**: Sharp imbalance spike + qty collapse + wide spread across observations.

When history is absent or insufficient, both temporal signals remain `false` and `imbalanceSlope` remains `null`.

## 6. BTC Context Provider

`BtcMicroContextProvider` maintains a bounded buffer of BTCUSDT 1m close prices.

- **`ret1m`**: `(current - 1m_ago) / 1m_ago` (decimal return).
- **`ret3m`**: `(current - 3m_ago) / 3m_ago` (decimal return).
- **`ret5m`**: `(current - 5m_ago) / 5m_ago` (decimal return).
- **`acceleration`**: `ret1m - ret3m / 3`.
- **`direction`**: `LONG` if `ret3m > 0.0001`, `SHORT` if `< -0.0001`, else `NEUTRAL`.

Units: `0.001 = 0.1% = 10 bps`. Consistent with existing contracts.

Fail-closed: insufficient candles, stale data (> 120s), future timestamps.

## 7. Reference Price

`MicroBurstReferencePriceProvider`:

- **Primary**: Best bid/ask midpoint from order book snapshot.
- **Fallback**: Mark price from REST (5s staleness threshold).
- **`marketPriceAtSnapshot`**: Added to `MicroBurstContext` as optional field.
- **`currentPrice`**: Unchanged — latest closed 1m candle close (causal replay reference).
- Entry policy geometry can use either price; `marketPriceAtSnapshot` is explicitly typed and documented.

## 8. AggTrade Buffer

`MicroBurstAggTradeBuffer`: bounded rolling history of aggTrade events.

- `getRecent()`: Events within age window.
- `getTakerFlow()`: Buy/sell volume, net taker volume, trade count.
- Available for: taker flow, absorption, sweep detection, momentum diagnostics.
- Not yet consumed by entry policy — documented as M2 scope.

## 9. Shadow Authority Semantics

```
MICRO_BURST_V1_SHADOW_AUTHORITY_ENABLED = false
MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED = false
```

- `MicroBurstShadowEvaluator` evaluates through `StrategyRouter`.
- When mode is `SHADOW`: strategy evaluates, produces `NO_TRADE` or `ENTRY_INTENT`.
- `WOULD_ENTER=true` is logged but `LIVE_EXECUTION=false` always.
- No `SharedStrategyExecutionService.execute()` call exists.
- No `marketOpen`, `placeStopClose`, `placeTpClose`, `closeSideMarketSafe` in domain code.

## 10. Duplicate Signal Protection

`MicroBurstDuplicateSignalGuard`:

- Key: `strategy:symbol:side:structuralLevel:bucket`.
- Bucket size: 60 seconds.
- Same signal within same bucket => `duplicateSuppressed: true`.
- Different sides, levels, or buckets => distinct signals.
- History: max 500 entries, 1h TTL.
- Telemetry: `shadowSignalId`, `firstObservedAt`, `lastObservedAt`.

## 11. Configuration

YAML structure:

```yaml
micro_burst:
  enabled: true
  mode: SHADOW
  symbols:
    BTCUSDT:
      enabled: true
      btcConflictThresholdBps: 30
      bookDepthLevels: 10
      bookDepthSpeed: 100ms
    ETHUSDT:
      enabled: true
```

Or via environment:

```
MICRO_BURST_V1_ENABLED=true
MICRO_BURST_V1_MODE=SHADOW
MICRO_BURST_V1_SYMBOLS=BTCUSDT,ETHUSDT
```

## 12. Fail-Closed Cases

Context becomes invalid when:

- Book missing, stale, unsynced, or anomalous.
- BTC missing or stale.
- Candle freshness invalid.
- Insufficient candles.
- Future candle timestamps.
- Invalid reference price.
- Invalid market price.

No fallback to fake BTC, empty book, stale data, or fabricated prices.

## 13. Files Changed / New

### New Files (8)

| File                                | Purpose                          |
| ----------------------------------- | -------------------------------- |
| `MicroBurstMarketDataTypes.ts`      | M1 type contracts                |
| `SynchronizedOrderBook.ts`          | Depth synchronization engine     |
| `BtcMicroContextProvider.ts`        | Real BTC 1m stream + returns     |
| `MicroBurstAggTradeBuffer.ts`       | Bounded aggTrade history         |
| `MicroBurstReferencePrice.ts`       | Mark price / midpoint provider   |
| `MicroBurstShadowEvaluator.ts`      | Shadow orchestration + telemetry |
| `MicroBurstDuplicateSignalGuard.ts` | Deterministic signal dedup       |
| `MicroBurstConfigLoader.ts`         | YAML/env config parsing          |

### New Test Files (8)

| File                                     | Tests    |
| ---------------------------------------- | -------- |
| `SynchronizedOrderBook.test.ts`          | 14 tests |
| `BtcMicroContextProvider.test.ts`        | 8 tests  |
| `MicroBurstAggTradeBuffer.test.ts`       | 5 tests  |
| `MicroBurstReferencePrice.test.ts`       | 5 tests  |
| `MicroBurstDuplicateSignalGuard.test.ts` | 6 tests  |
| `MicroBurstConfigLoader.test.ts`         | 9 tests  |
| `MicroBurstShadowEvaluator.test.ts`      | 6 tests  |
| `MicroBurstM1Audit.test.ts`              | 5 tests  |

### Modified Files (5)

| File                                | Change                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `MicroBurstTypes.ts`                | Added `marketPriceAtSnapshot` to context, `temporalAbsorptionDetected`/`temporalSweepDetected` to BookPressureSignal |
| `MicroBurstContextBuilder.ts`       | Added `ReferencePriceProvider` dep, `marketPriceAtSnapshot` in returned context                                      |
| `MicroBurstBookPressureAnalyzer.ts` | Added temporal history parameter, imbalance slope computation, temporal absorption/sweep detection                   |
| `MicroBurst.test-support.ts`        | Added new BookPressureSignal fields to test fixture                                                                  |
| `MicroBurstArchitecture.test.ts`    | Unchanged (invariant scan continues to pass)                                                                         |

## 14. Test Matrix

| Category          | Files  | Tests   | Status   |
| ----------------- | ------ | ------- | -------- |
| M1 new components | 8      | 58      | PASS     |
| M1 audit          | 1      | 5       | PASS     |
| Micro Burst total | 22     | 180+    | PASS     |
| Shared execution  | 1      | 24      | PASS     |
| Aegis live        | 1      | 108     | PASS     |
| Position managers | 1      | 4       | PASS     |
| Restoration       | 1      | 4       | PASS     |
| **Full suite**    | **91** | **935** | **PASS** |

## 15. Known Limitations / M2 Scope

- AggTrade data is buffered but not consumed by entry policy.
- Temporal absorption/sweep detection is basic (threshold-based).
- No live depth subscription wiring in TradingService yet (providers must be wired at startup).
- No periodic BTC poll scheduler in TradingService yet.
- `MicroBurstStrategy` mode remains `OFF` — shadow evaluator wraps the router directly.
- Duplicate suppression bucket is 60s; may need tuning for high-frequency signals.

## 16. Commit SHA

`5813704` — `feat: add micro burst synchronized market data shadow plane`

## 17. Explicit Statement

**LIVE remains false.** No Micro Burst code path can reach `SharedStrategyExecutionService.execute()`. No exchange mutation is possible from Micro Burst domain code. The M1 data plane is observational only.
